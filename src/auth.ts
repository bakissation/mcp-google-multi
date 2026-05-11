import { google } from 'googleapis';
import http from 'node:http';
import { URL } from 'node:url';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import open from 'open';
import destroyer from 'server-destroy';
import { ACCOUNTS, ACCOUNT_CONFIG } from './accounts.js';

// ─── Scope tiers ────────────────────────────────────────────────────────
//
// BASE: always granted. Existing v3 surface + Tasks + Meet (added in v4.0.0).
// OPTIONAL: per-account opt-in via env GOOGLE_OPTIONAL_SCOPES="forms,chat".
// ADMIN: per-account opt-in via env GOOGLE_ADMIN_ACCOUNTS="alias1,alias2".
//
// Personal Gmail accounts will 403 on admin scopes — never grant by default.
// ────────────────────────────────────────────────────────────────────────

export const BASE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/webmasters',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/meetings.space.readonly',
];

export const OPTIONAL_SCOPE_BUNDLES: Record<string, string[]> = {
  forms: [
    'https://www.googleapis.com/auth/forms.body',
    'https://www.googleapis.com/auth/forms.responses.readonly',
  ],
  chat: [
    'https://www.googleapis.com/auth/chat.spaces',
    'https://www.googleapis.com/auth/chat.messages',
    'https://www.googleapis.com/auth/chat.messages.create',
  ],
};

export const ADMIN_SCOPES = [
  'https://www.googleapis.com/auth/admin.reports.audit.readonly',
  'https://www.googleapis.com/auth/apps.alerts',
  'https://www.googleapis.com/auth/admin.directory.user',
  'https://www.googleapis.com/auth/admin.directory.group.readonly',
  'https://www.googleapis.com/auth/admin.directory.group.member.readonly',
];

/** Parse comma-separated env value into a deduplicated string array. */
function parseCsvEnv(name: string): string[] {
  return (process.env[name]?.trim() ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/** Bundle keys enabled via GOOGLE_OPTIONAL_SCOPES (e.g. ["forms","chat"]). */
export function getOptionalBundles(): string[] {
  return parseCsvEnv('GOOGLE_OPTIONAL_SCOPES').filter(b => b in OPTIONAL_SCOPE_BUNDLES);
}

/** Account aliases granted ADMIN_SCOPES via GOOGLE_ADMIN_ACCOUNTS. */
export function getAdminAccounts(): string[] {
  return parseCsvEnv('GOOGLE_ADMIN_ACCOUNTS');
}

/**
 * Compose the scope list for a single account at consent time.
 * Resolves env flags: GOOGLE_OPTIONAL_SCOPES (global) and GOOGLE_ADMIN_ACCOUNTS (per-account allowlist).
 */
export function resolveScopesForAccount(alias: string): string[] {
  const scopes = [...BASE_SCOPES];

  for (const bundle of getOptionalBundles()) {
    scopes.push(...OPTIONAL_SCOPE_BUNDLES[bundle]);
  }

  if (getAdminAccounts().includes(alias)) {
    scopes.push(...ADMIN_SCOPES);
  }

  return Array.from(new Set(scopes));
}

/** True if admin writes are explicitly enabled. Default refuses to prevent accidents on small orgs. */
export function adminWritesEnabled(): boolean {
  return process.env.GOOGLE_ALLOW_ADMIN_WRITES === 'true';
}

export async function runAuthFlow(args: string[]): Promise<void> {
  const accountIdx = args.indexOf('--account');
  if (accountIdx === -1 || !args[accountIdx + 1]) {
    console.error('Usage: node dist/index.js auth --account <alias>');
    console.error(`Valid aliases: ${ACCOUNTS.join(', ')}`);
    process.exit(1);
  }

  const alias = args[accountIdx + 1];
  if (!ACCOUNTS.includes(alias)) {
    console.error(`Unknown account "${alias}". Valid aliases: ${ACCOUNTS.join(', ')}`);
    process.exit(1);
  }

  const config = ACCOUNT_CONFIG[alias];
  const scopes = resolveScopesForAccount(alias);

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'http://localhost:4242/oauth2callback',
  );

  // CSRF protection for the OAuth callback (RFC 6749 §10.12).
  const expectedState = randomBytes(32).toString('hex');

  const authorizeUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
    login_hint: config.email,
    state: expectedState,
  });

  console.log(`Authenticating account "${alias}" (${config.email})...`);
  console.log(`Requesting ${scopes.length} scopes.`);
  if (getAdminAccounts().includes(alias)) {
    console.log('  ⚠ Admin scopes included — this account will be granted Workspace admin access.');
  }
  console.log(`Opening browser for authorization...`);

  return new Promise((resolve, reject) => {
    const server = http
      .createServer(async (req, res) => {
        try {
          if (req.url && req.url.startsWith('/oauth2callback')) {
            const qs = new URL(req.url, 'http://localhost:4242').searchParams;

            const error = qs.get('error');
            if (error) {
              res.writeHead(400, { 'Content-Type': 'text/plain' });
              res.end(`Authorization denied: ${error}`);
              (server as any).destroy();
              reject(new Error(`Authorization denied: ${error}`));
              return;
            }

            const code = qs.get('code');
            if (!code) {
              res.writeHead(400, { 'Content-Type': 'text/plain' });
              res.end('No authorization code received.');
              (server as any).destroy();
              reject(new Error('No authorization code received'));
              return;
            }

            const returnedState = qs.get('state');
            if (returnedState !== expectedState) {
              res.writeHead(400, { 'Content-Type': 'text/plain' });
              res.end('State mismatch — possible CSRF attempt. Aborting.');
              (server as any).destroy();
              reject(new Error('OAuth state token mismatch'));
              return;
            }

            const { tokens } = await oauth2Client.getToken(code);

            await fs.mkdir(path.dirname(config.tokenPath), { recursive: true });
            // 0o600: tokens grant full account access; keep them user-only.
            await fs.writeFile(
              config.tokenPath,
              JSON.stringify(tokens, null, 2),
              { mode: 0o600 },
            );

            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(
              '<h2>Authentication successful!</h2><p>You can close this tab.</p>',
            );
            (server as any).destroy();

            console.log(`Token saved to ${config.tokenPath}`);
            resolve();
          }
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal error during authentication.');
          (server as any).destroy();
          reject(e);
        }
      })
      // Bind to loopback only — never expose the OAuth callback to the local network.
      .listen(4242, '127.0.0.1', () => {
        open(authorizeUrl, { wait: false }).then((cp) => cp.unref());
      });

    destroyer(server);

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error('Port 4242 is already in use. Close the process using it and retry.');
        process.exit(1);
      }
      reject(err);
    });
  });
}
