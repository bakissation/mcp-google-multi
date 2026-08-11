import { OAuth2Client } from 'googleapis-common';
import http from 'node:http';
import { URL } from 'node:url';

// Shared loopback OAuth consent (leg C of cc-auth), used by the account wizard
// (B7). The `auth --account` CLI keeps its own inline copy for now; this module
// is the reusable, live-server-safe form (throws typed errors instead of
// process.exit, and times out so a never-completed consent can't wedge a tool
// call forever). The redirect matches the CLI exactly so an existing registered
// Desktop client keeps working.

export const LOOPBACK_PORT = 4242;
export const LOOPBACK_REDIRECT = `http://localhost:${LOOPBACK_PORT}/oauth2callback`;

/** GOOGLE_CLIENT_ID/SECRET absent — caller maps to E_CLIENT_CREDENTIALS_MISSING. */
export class ClientCredentialsMissingError extends Error {
  constructor() {
    super('E_CLIENT_CREDENTIALS_MISSING: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set.');
  }
}
export class LoopbackPortInUseError extends Error {
  constructor() {
    super(`E_LOOPBACK_PORT_IN_USE: port ${LOOPBACK_PORT} is already in use; close the other process and retry.`);
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

export function hasClientCredentials(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/** Build the loopback OAuth2 client from env credentials (throws if unset). */
export function buildConsentClient(): OAuth2Client {
  if (!hasClientCredentials()) throw new ClientCredentialsMissingError();
  return new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, LOOPBACK_REDIRECT);
}

/**
 * Start the loopback server, await the OAuth redirect, validate the CSRF
 * `state` (RFC 6749 §10.12), and exchange the code. Returns the token set for
 * the caller to persist. Never process.exit's (safe inside a live server) and
 * times out so a stalled consent can't wedge a tool call.
 */
export function awaitLoopbackConsent(
  client: OAuth2Client,
  expectedState: string,
  opts: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const server = http.createServer(async (req, res) => {
      if (!req.url || !req.url.startsWith('/oauth2callback')) {
        res.writeHead(404).end();
        return;
      }
      const done = (code: number, body: string) => {
        res.writeHead(code, { 'Content-Type': 'text/html' });
        res.end(body);
        if (timer) clearTimeout(timer);
        server.close();
        server.closeAllConnections();
      };
      try {
        const qs = new URL(req.url, LOOPBACK_REDIRECT).searchParams;
        const error = qs.get('error');
        if (error) {
          done(400, `<p>Authorization denied: ${error}</p>`);
          reject(new ConsentDeniedError(error));
          return;
        }
        const returnedState = qs.get('state');
        if (returnedState !== expectedState) {
          done(400, '<p>State mismatch — possible CSRF attempt. Aborting.</p>');
          reject(new Error('E_OAUTH_STATE_MISMATCH: OAuth state token mismatch'));
          return;
        }
        const code = qs.get('code');
        if (!code) {
          done(400, '<p>No authorization code received.</p>');
          reject(new ConsentDeniedError('no authorization code received'));
          return;
        }
        const { tokens } = await client.getToken(code);
        done(200, '<h2>Authentication successful!</h2><p>You can close this tab.</p>');
        resolve(tokens as Record<string, unknown>);
      } catch (e) {
        done(500, '<p>Internal error during authentication.</p>');
        reject(e);
      }
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      reject(err.code === 'EADDRINUSE' ? new LoopbackPortInUseError() : err);
    });

    server.listen(LOOPBACK_PORT, '127.0.0.1', () => {
      timer = setTimeout(() => {
        server.close();
        server.closeAllConnections();
        reject(new ConsentTimeoutError());
      }, timeoutMs);
      // unref so a pending consent never keeps the process alive on its own.
      timer.unref?.();
    });
  });
}
