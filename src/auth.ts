import { randomBytes } from 'node:crypto';
import { openUrl } from './open-url.js';
import { ACCOUNTS, getAccountSet } from './accounts.js';
import type { AccountSet } from './accounts.js';
import { ADMIN_SCOPES, BUNDLE_CATALOG, adminBundleGrantHint, closestBundle, isAdminBundle, isKnownBundle, resolveBundleAliases } from './scope-catalog.js';
import { resolveMasterKey } from './master-key.js';
import type { ScopeProfile } from './scope-catalog.js';
import { writeToken } from './token-store.js';
import { buildConsentClient, openLoopbackConsent, TESTING_MODE_WARNING } from './oauth-consent.js';

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
// scope-catalog.ts is the source of truth. The admin bundles are per-account, not optional.
export const OPTIONAL_SCOPE_BUNDLES: Record<string, string[]> = Object.fromEntries(
  Object.entries(BUNDLE_CATALOG)
    .filter(([name]) => !isAdminBundle(name))
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

// A set GOOGLE_OPTIONAL_SCOPES acts as an implicit profile applied to every
// account (env wins over file profiles); unknown names fail loudly.
function legacyGlobalProfile(): ScopeProfile | null {
  const names = parseCsvEnv('GOOGLE_OPTIONAL_SCOPES');
  if (names.length === 0) return null;
  const bundles = resolveBundleAliases(names);
  // Boot-time validation lives in resolveAccounts (runs whatever
  // GOOGLE_TOOLSETS selects); this is defense-in-depth for direct callers.
  for (const bundle of bundles) {
    if (isAdminBundle(bundle)) {
      throw new Error(
        `E_UNKNOWN_BUNDLE: "${bundle}" is not a global bundle: ${adminBundleGrantHint(bundle)}.`,
      );
    }
    if (!isKnownBundle(bundle)) {
      const hint = closestBundle(bundle);
      throw new Error(
        `E_UNKNOWN_BUNDLE: unknown bundle "${bundle}" in GOOGLE_OPTIONAL_SCOPES${hint ? ` — did you mean "${hint}"?` : ''}`,
      );
    }
  }
  return { bundles };
}

function profileForAccount(alias: string, set: AccountSet = getAccountSet()): ScopeProfile {
  const legacy = legacyGlobalProfile();
  if (legacy) return legacy;
  const name = set.configs[alias]?.scopeProfile ?? 'base';
  // hasOwn: a profile named like an Object.prototype member must never
  // resolve to the inherited function.
  return Object.hasOwn(set.scopeProfiles, name) ? set.scopeProfiles[name] : { bundles: [] };
}

/** Union of every account's resolved bundles: a service registers if ANY
 * account can authorize it; per-account authz happens at call time. */
export function getOptionalBundles(set: AccountSet = getAccountSet()): string[] {
  const legacy = legacyGlobalProfile();
  if (legacy) return legacy.bundles.filter(b => !isAdminBundle(b));
  const union = new Set<string>();
  for (const alias of set.aliases) {
    for (const b of profileForAccount(alias, set).bundles) {
      if (!isAdminBundle(b)) union.add(b);
    }
  }
  return [...union];
}

/** Aliases granted ADMIN_SCOPES (read and write): per-account admin flag (env
 * GOOGLE_ADMIN_ACCOUNTS overrides config.json at resolve) OR the account's
 * scope profile carrying admin (boolean or "admin" bundle) — equivalent forms. */
export function getFullAdminAccounts(set: AccountSet = getAccountSet()): string[] {
  const { aliases, configs } = set;
  return aliases.filter((a) => {
    if (configs[a].admin === true) return true;
    const p = profileForAccount(a, set);
    return p.admin === true || p.bundles.includes('admin');
  });
}

/** Aliases that enable the admin service: the full admin ones plus those whose
 * profile carries only the read-only bundle (its own scopes come from the
 * catalog loop, never ADMIN_SCOPES). */
export function getAdminAccounts(set: AccountSet = getAccountSet()): string[] {
  const full = new Set(getFullAdminAccounts(set));
  return set.aliases.filter((a) => full.has(a) || profileForAccount(a, set).bundles.includes('admin_readonly'));
}

/** Scopes are fixed at consent time: changing an account's profile (or the
 * legacy env) changes its consent set and requires re-running auth. Evaluated
 * per account: `work` can carry admin + gmail_settings while `personal` is
 * never asked for them. */
export function resolveScopesForAccount(alias: string, set: AccountSet = getAccountSet()): string[] {
  const profile = profileForAccount(alias, set);
  const scopes = profile.includesBase === false ? [] : [...BASE_SCOPES];

  for (const bundle of profile.bundles) {
    if (bundle === 'admin') continue;
    scopes.push(...BUNDLE_CATALOG[bundle].scopes);
  }

  if (getFullAdminAccounts(set).includes(alias)) {
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

  // Auto-provisions on a fresh install (env > keychain > file > generate);
  // resolves eagerly so a provisioning failure surfaces before the browser opens.
  resolveMasterKey();

  // Listen first, then build the auth URL from the assigned redirect; errors
  // propagate to main()'s fatal handler like every other CLI failure.
  const loop = await openLoopbackConsent({ timeoutMs: 10 * 60_000 });
  const oauth2Client = buildConsentClient(loop.redirect);

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
  if (getFullAdminAccounts().includes(alias)) {
    console.log('  ⚠ Admin scopes included — this account will be granted Workspace admin access.');
  } else if (getAdminAccounts().includes(alias)) {
    console.log('  ⚠ Read-only admin scopes included: this account will be able to read Workspace users, groups, org units and audit reports.');
  }
  // Always print the URL first: the browser launch is best-effort and
  // silently does nothing on headless/SSH sessions.
  console.log(`Opening your browser to authorize "${alias}". If nothing opens, visit:\n${authorizeUrl}`);
  openUrl(authorizeUrl);

  const tokens = await loop.finish(oauth2Client, expectedState);
  writeToken(alias, tokens);

  console.log(`Token saved (encrypted) for ${alias}.`);
  console.log(TESTING_MODE_WARNING);
  console.log('Next: authenticate your other aliases, then verify with: mcp-google-multi config check');
}
