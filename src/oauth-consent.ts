import { OAuth2Client } from 'googleapis-common';
import http from 'node:http';
import { URL } from 'node:url';
import type { AddressInfo } from 'node:net';

// Shared loopback OAuth consent (leg C of cc-auth), used by the account wizard
// (B7) and the `auth --account` CLI. Live-server-safe: typed errors instead of
// process.exit, and a timeout so a never-completed consent can't wedge a tool
// call forever. The listener binds an EPHEMERAL loopback port (RFC 8252 §7.3;
// Google Desktop clients accept any http://localhost:<port> redirect), so a
// second local process on a fixed port can never break auth.

/** GOOGLE_CLIENT_ID/SECRET absent — caller maps to E_CLIENT_CREDENTIALS_MISSING. */
export class ClientCredentialsMissingError extends Error {
  constructor() {
    super('E_CLIENT_CREDENTIALS_MISSING: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set.');
  }
}
export class LoopbackPortInUseError extends Error {
  constructor() {
    super('E_LOOPBACK_PORT_IN_USE: the loopback consent listener could not bind a port; retry.');
  }
}
export class ConsentTimeoutError extends Error {
  constructor() {
    super('E_CONSENT_TIMEOUT: no OAuth redirect arrived before the timeout.');
  }
}
export class ConsentDeniedError extends Error {
  constructor(reason: string) {
    super(`E_CONSENT_DENIED: ${reason}`);
  }
}

// Surfaced after every successful consent: the expiry is invisible until the
// token dies a week later as reauth_required, so the moment of success is the
// one place the warning is guaranteed to be seen. Full walkthrough in
// docs/google-cloud-setup.md.
export const TESTING_MODE_WARNING =
  'Heads-up: while your OAuth client\'s Publishing status is "Testing", Google expires refresh tokens after 7 days (weekly re-auth for every account). ' +
  'When your setup works, set it to "In production" at https://console.cloud.google.com/auth/audience. ' +
  'No verification review is needed for personal use; see docs/google-cloud-setup.md.';

export function hasClientCredentials(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/**
 * Build the loopback OAuth2 client from env credentials (throws if unset).
 * `redirect` comes from openLoopbackConsent(): the port is only known once the
 * listener is bound.
 */
export function buildConsentClient(redirect: string): OAuth2Client {
  if (!hasClientCredentials()) throw new ClientCredentialsMissingError();
  return new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirect);
}

export interface LoopbackConsent {
  /** `http://localhost:<ephemeral port>/oauth2callback` — build the auth URL from this. */
  redirect: string;
  /**
   * Await the OAuth redirect, validate the CSRF `state` (RFC 6749 §10.12), and
   * exchange the code. Returns the token set for the caller to persist.
   */
  finish(client: OAuth2Client, expectedState: string): Promise<Record<string, unknown>>;
  /**
   * Abandon the consent: shuts the listener down WITHOUT settling finish(), so
   * an abandoned flow can never surface as an unhandled rejection later.
   */
  close(): void;
}

/**
 * Bind the loopback listener first (ephemeral port), so the redirect URI is
 * known before the auth URL is built and the callback can't race the browser.
 */
export function openLoopbackConsent(opts: { timeoutMs?: number } = {}): Promise<LoopbackConsent> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  return new Promise((resolveOpen, rejectOpen) => {
    let redirect = '';
    let timer: NodeJS.Timeout | undefined;
    let closed = false;
    let pending:
      | {
          client: OAuth2Client;
          expectedState: string;
          resolve: (tokens: Record<string, unknown>) => void;
          reject: (err: unknown) => void;
        }
      | undefined;

    const shutdown = () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      server.close();
      server.closeAllConnections();
    };
    const fail = (err: unknown) => {
      const p = pending;
      pending = undefined;
      shutdown();
      p?.reject(err);
    };

    const server = http.createServer(async (req, res) => {
      if (!req.url || !req.url.startsWith('/oauth2callback')) {
        res.writeHead(404).end();
        return;
      }
      if (!pending) {
        // Only reachable if something other than our own browser launch hit
        // the port before finish() armed the exchange; nothing to do with it.
        res.writeHead(503).end();
        return;
      }
      const p = pending;
      const done = (code: number, body: string) => {
        res.writeHead(code, { 'Content-Type': 'text/html' });
        res.end(body);
      };
      try {
        const qs = new URL(req.url, redirect).searchParams;
        const error = qs.get('error');
        if (error) {
          done(400, `<p>Authorization denied: ${error}</p>`);
          fail(new ConsentDeniedError(error));
          return;
        }
        const returnedState = qs.get('state');
        if (returnedState !== p.expectedState) {
          done(400, '<p>State mismatch: possible CSRF attempt. Aborting.</p>');
          fail(new Error('E_OAUTH_STATE_MISMATCH: OAuth state token mismatch'));
          return;
        }
        const code = qs.get('code');
        if (!code) {
          done(400, '<p>No authorization code received.</p>');
          fail(new ConsentDeniedError('no authorization code received'));
          return;
        }
        const { tokens } = await p.client.getToken(code);
        done(200, '<h2>Authentication successful!</h2><p>You can close this tab.</p>');
        pending = undefined;
        shutdown();
        p.resolve(tokens as Record<string, unknown>);
      } catch (e) {
        done(500, '<p>Internal error during authentication.</p>');
        fail(e);
      }
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      const mapped = err.code === 'EADDRINUSE' ? new LoopbackPortInUseError() : err;
      if (pending) {
        fail(mapped);
      } else {
        shutdown();
        rejectOpen(mapped);
      }
    });

    // Bind to loopback only — never expose the OAuth callback to the local network.
    server.listen(0, '127.0.0.1', () => {
      redirect = `http://localhost:${(server.address() as AddressInfo).port}/oauth2callback`;
      timer = setTimeout(() => fail(new ConsentTimeoutError()), timeoutMs);
      // unref so a pending consent never keeps the process alive on its own.
      timer.unref?.();
      resolveOpen({
        redirect,
        finish(client, expectedState) {
          return new Promise((resolve, reject) => {
            if (closed) {
              reject(new ConsentTimeoutError());
              return;
            }
            pending = { client, expectedState, resolve, reject };
          });
        },
        close: shutdown,
      });
    });
  });
}
