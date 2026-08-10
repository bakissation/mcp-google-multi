import { OAuth2Client } from 'googleapis-common';
import http from 'node:http';
import { URL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { openUrl } from './open-url.js';
import { ACCOUNTS, getAccountSet } from './accounts.js';
import { ADMIN_SCOPES, BUNDLE_CATALOG, closestBundle, resolveBundleAliases } from './scope-catalog.js';
import type { ScopeProfile } from './scope-catalog.js';
import { writeToken } from './token-store.js';

// Personal (non-Workspace) accounts 403 on admin scopes; ADMIN_SCOPES stays per-account opt-in, never granted by default.

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

// Kept as a derived view for compat (docs generator, tests); the catalog in
// scope-catalog.ts is the source of truth. "admin" is not an optional bundle.
export const OPTIONAL_SCOPE_BUNDLES: Record<string, string[]> = Object.fromEntries(
  Object.entries(BUNDLE_CATALOG)
    .filter(([name]) => name !== 'admin')
    .map(([name, entry]) => [name, entry.scopes]),
);

export { ADMIN_SCOPES };

/** Parse comma-separated env value into a deduplicated string array. */
function parseCsvEnv(name: string): string[] {
  return (process.env[name]?.trim() ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Legacy global override (BC7): a set GOOGLE_OPTIONAL_SCOPES acts as an
 * implicit "legacy-global" profile applied to every account (env wins over
 * file profiles, cc-config R2). Unknown names now fail loudly (BR3) where v5
 * silently dropped them — the intended migration signal.
 */
function legacyGlobalProfile(): ScopeProfile | null {
  const names = parseCsvEnv('GOOGLE_OPTIONAL_SCOPES');
  if (names.length === 0) return null;
  const bundles = resolveBundleAliases(names);
  // Boot-time validation lives in resolveAccounts (runs whatever
  // GOOGLE_TOOLSETS selects); this is defense-in-depth for direct callers.
  for (const bundle of bundles) {
    if (bundle === 'admin') {
      throw new Error(
        'E_UNKNOWN_BUNDLE: "admin" is not a global bundle: grant it per account via GOOGLE_ADMIN_ACCOUNTS or an "admin: true" scope profile.',
      );
    }
    if (!(bundle in BUNDLE_CATALOG)) {
      const hint = closestBundle(bundle);
      throw new Error(
        `E_UNKNOWN_BUNDLE: unknown bundle "${bundle}" in GOOGLE_OPTIONAL_SCOPES${hint ? ` — did you mean "${hint}"?` : ''}`,
      );
    }
  }
  return { bundles };
}

function profileForAccount(alias: string): ScopeProfile {
  const legacy = legacyGlobalProfile();
  if (legacy) return legacy;
  const set = getAccountSet();
  const name = set.configs[alias]?.scopeProfile ?? 'base';
  // hasOwn: a profile named like an Object.prototype member must never
  // resolve to the inherited function.
  return Object.hasOwn(set.scopeProfiles, name) ? set.scopeProfiles[name] : { bundles: [] };
}

/** Union of every account's resolved bundles: a service registers if ANY
 * account can authorize it; per-account authz happens at call time (BR2). */
export function getOptionalBundles(): string[] {
  const legacy = legacyGlobalProfile();
  if (legacy) return legacy.bundles.filter(b => b !== 'admin');
  const union = new Set<string>();
  const set = getAccountSet();
  for (const alias of set.aliases) {
    for (const b of profileForAccount(alias).bundles) {
      if (b !== 'admin') union.add(b);
    }
  }
  return [...union];
}

/** Aliases granted ADMIN_SCOPES: per-account admin flag (env
 * GOOGLE_ADMIN_ACCOUNTS overrides config.json at resolve) OR the account's
 * scope profile carrying admin (boolean or "admin" bundle) — equivalent forms. */
export function getAdminAccounts(): string[] {
  const { aliases, configs } = getAccountSet();
  return aliases.filter((a) => {
    if (configs[a].admin === true) return true;
    const p = profileForAccount(a);
    return p.admin === true || p.bundles.includes('admin');
  });
}

/** Scopes are fixed at consent time: changing an account's profile (or the
 * legacy env) changes its consent set and requires re-running auth. Evaluated
 * per account: `work` can carry admin + gmail_settings while `personal` is
 * never asked for them. */
export function resolveScopesForAccount(alias: string): string[] {
  const profile = profileForAccount(alias);
  const scopes = profile.includesBase === false ? [] : [...BASE_SCOPES];

  for (const bundle of profile.bundles) {
    if (bundle === 'admin') continue;
    scopes.push(...BUNDLE_CATALOG[bundle].scopes);
  }

  if (getAdminAccounts().includes(alias)) {
    scopes.push(...ADMIN_SCOPES);
  }

  return Array.from(new Set(scopes));
}


export async function runAuthFlow(args: string[]): Promise<void> {
  const accountIdx = args.indexOf('--account');
  if (accountIdx === -1 || !args[accountIdx + 1]) {
    console.error('Usage: mcp-google-multi auth --account <alias>');
    console.error(`Valid aliases: ${ACCOUNTS.join(', ')}`);
    process.exit(1);
  }

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.error(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set. Create an OAuth Desktop client ' +
        '(see docs/google-cloud-setup.md) and add both to your environment before authenticating.',
    );
    process.exit(1);
  }

  const alias = args[accountIdx + 1];
  if (!ACCOUNTS.includes(alias)) {
    console.error(`Unknown account "${alias}". Valid aliases: ${ACCOUNTS.join(', ')}`);
    process.exit(1);
  }

  const config = getAccountSet().configs[alias];
  const scopes = resolveScopesForAccount(alias);

  if (!process.env.MASTER_KEY) {
    console.error(
      'MASTER_KEY is not set. Generate one (openssl rand -base64 32) and add it to .env before authenticating.',
    );
    process.exit(1);
  }

  const oauth2Client = new OAuth2Client(
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
              server.close();
              server.closeAllConnections();
              reject(new Error(`Authorization denied: ${error}`));
              return;
            }

            const code = qs.get('code');
            if (!code) {
              res.writeHead(400, { 'Content-Type': 'text/plain' });
              res.end('No authorization code received.');
              server.close();
              server.closeAllConnections();
              reject(new Error('No authorization code received'));
              return;
            }

            const returnedState = qs.get('state');
            if (returnedState !== expectedState) {
              res.writeHead(400, { 'Content-Type': 'text/plain' });
              res.end('State mismatch — possible CSRF attempt. Aborting.');
              server.close();
              server.closeAllConnections();
              reject(new Error('OAuth state token mismatch'));
              return;
            }

            const { tokens } = await oauth2Client.getToken(code);

            writeToken(alias, tokens);

            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(
              '<h2>Authentication successful!</h2><p>You can close this tab.</p>',
            );
            server.close();
            server.closeAllConnections();

            console.log(`Token saved (encrypted) for ${alias}.`);
            console.log('Next: authenticate your other aliases, then verify with: mcp-google-multi config check');
            resolve();
          }
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal error during authentication.');
          server.close();
          server.closeAllConnections();
          reject(e);
        }
      })
      // Bind to loopback only — never expose the OAuth callback to the local network.
      .listen(4242, '127.0.0.1', () => {
        // Always print the URL first: the browser launch is best-effort and
        // silently does nothing on headless/SSH sessions.
        console.log(`Opening your browser to authorize "${alias}". If nothing opens, visit:\n${authorizeUrl}`);
        openUrl(authorizeUrl);
      });


    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error('Port 4242 is already in use. Close the process using it and retry.');
        process.exit(1);
      }
      reject(err);
    });
  });
}
