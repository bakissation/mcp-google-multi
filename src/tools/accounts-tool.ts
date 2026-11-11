import { reauthHint } from '../reauth-hint.js';
import * as fs from 'node:fs';
import type { ToolRegistry } from '../registry.js';
import { getAccountSet, refreshAccountSetIfStale, type AccountSet } from '../accounts.js';
import { buildScopesReport, type ScopesReport } from '../scope-observability.js';
import { getAdminAccounts, getFullAdminAccounts, resolveScopesForAccount } from '../auth.js';
import { hasToken, readToken, type TokenStore } from '../token-store.js';
import { hints } from '../hint-provider.js';
import { coerceBoolean } from './_coerce.js';

export interface AccountHealthDeps {
  hasToken: (alias: string) => boolean;
  readToken: (alias: string) => { expiry_date?: number; refresh_token?: string; scope?: string } | null;
  fileExists: (p: string) => boolean;
  now: () => number;
  /** Scopes required by registered tools — feeds doctor's tool-grained
   * "registered but not requestable" view. account_list stays compact:
   * its report universe is profile ∪ granted only. */
  registeredScopes?: () => string[];
  /** Account view health is derived against; absent = the global registry. */
  accounts?: () => AccountSet;
}

/** Health deps over one context's token store (and, optionally, its account
 * view); the module-level functions are the single owner's store. */
export function accountHealthDepsFor(
  store: Pick<TokenStore, 'hasToken' | 'readToken'>,
  accounts?: () => AccountSet,
): AccountHealthDeps {
  return {
    hasToken: store.hasToken,
    readToken: store.readToken,
    fileExists: fs.existsSync,
    now: Date.now,
    ...(accounts ? { accounts } : {}),
  };
}

const DEFAULT_DEPS: AccountHealthDeps = accountHealthDepsFor({ hasToken, readToken });

export type TokenStatus = 'ok' | 'expired_refreshable' | 'needs_reauth' | 'missing' | 'decrypt_error';

export interface AccountHealth {
  alias: string;
  email: string;
  admin: boolean;
  /** Set only for read-only admin accounts (`admin_readonly`); `admin` stays true for them. */
  adminLevel?: 'readonly';
  source: 'config' | 'env';
  sourceNote?: string;
  token: { status: TokenStatus; expiryDate?: string; hint?: string };
  scopes: ScopesReport;
}

export function deriveAccountHealth(alias: string, deps: AccountHealthDeps = DEFAULT_DEPS): AccountHealth {
  const set = (deps.accounts ?? getAccountSet)();
  const config = set.configs[alias];
  const admin = getAdminAccounts(set).includes(alias);
  const readOnlyAdmin = admin && !getFullAdminAccounts(set).includes(alias);
  const configured = resolveScopesForAccount(alias, set);
  // Env-sourced accounts are not persisted in config.json, so the
  // account wizard cannot edit them — the deployer edits env instead.
  const base = {
    alias,
    email: config.email,
    admin,
    ...(readOnlyAdmin ? { adminLevel: 'readonly' as const } : {}),
    source: config.source,
    ...(config.source === 'env'
      ? { sourceNote: 'Defined by GOOGLE_ACCOUNTS env (not editable via config.json)' }
      : {}),
  };
  const profileSet = new Set(configured);
  const registered = deps.registeredScopes?.() ?? [];
  const noScopes = buildScopesReport(new Set<string>(), profileSet, registered);

  if (!deps.hasToken(alias)) {
    const legacy = deps.fileExists(config.tokenPath);
    const rendered = legacy
      ? hints()?.render({ kind: 'legacy_plaintext_token', account: alias })
      : hints()?.render({ kind: 'reauth', account: alias });
    return {
      ...base,
      token: {
        status: 'missing',
        hint:
          rendered?.hint ??
          (legacy
            ? 'Plaintext token.json found — run: npx mcp-google-multi migrate-tokens'
            : reauthHint(alias)),
      },
      scopes: noScopes,
    };
  }

  let token: ReturnType<AccountHealthDeps['readToken']>;
  try {
    token = deps.readToken(alias);
  } catch {
    const rendered = hints()?.render({ kind: 'token_unreadable', account: alias });
    return {
      ...base,
      token: { status: 'decrypt_error', hint: rendered?.hint ?? 'Wrong MASTER_KEY or corrupt token file — re-auth or restore the key.' },
      scopes: noScopes,
    };
  }

  const granted = typeof token?.scope === 'string' ? token.scope.split(' ').filter(Boolean) : [];
  const report = buildScopesReport(new Set(granted), profileSet, registered);
  const missing = report.requestable;
  const expiry = typeof token?.expiry_date === 'number' ? token.expiry_date : undefined;
  const refreshable = typeof token?.refresh_token === 'string' && token.refresh_token.length > 0;

  let status: TokenStatus;
  if (expiry !== undefined && expiry > deps.now()) status = 'ok';
  else if (refreshable) status = 'expired_refreshable';
  else status = 'needs_reauth';

  return {
    ...base,
    token: {
      status,
      expiryDate: expiry !== undefined ? new Date(expiry).toISOString() : undefined,
      hint:
        status === 'needs_reauth'
          ? (hints()?.render({ kind: 'reauth', account: alias })?.hint ?? reauthHint(alias))
          : missing.length > 0
            ? (hints()?.render({ kind: 'scopes_missing', account: alias })?.hint ?? 'Re-auth to grant the missing scopes')
            : undefined,
    },
    scopes: report,
  };
}

export interface AccountSummary {
  alias: string;
  email: string;
  admin: boolean;
  adminLevel?: 'readonly';
  tokenStatus: TokenStatus;
  default: boolean;
}

function summarizeAccountHealth(health: AccountHealth, isDefault: boolean): AccountSummary {
  return {
    alias: health.alias,
    email: health.email,
    admin: health.admin,
    ...(health.adminLevel ? { adminLevel: health.adminLevel } : {}),
    tokenStatus: health.token.status,
    default: isDefault,
  };
}

export function registerAccountTools(registry: ToolRegistry, deps: AccountHealthDeps = DEFAULT_DEPS): void {
  const registerMeta = registry.registerMeta as unknown as (
    name: string,
    config: { description: string; inputSchema: Record<string, unknown>; _meta?: Record<string, unknown> },
    handler: (args: { verbose?: boolean }) => unknown,
  ) => void;
  registerMeta(
    'account_list',
    {
      description:
        'List the configured Google accounts: alias, email, admin flag, token status ' +
        '(ok / expired_refreshable / needs_reauth / missing / decrypt_error), and which one is the default. ' +
        'Pass verbose: true for the full per-account report (granted vs configured scopes).',
      inputSchema: { verbose: coerceBoolean.optional().describe('Return the full scope report instead of the terse default') },
      _meta: { 'anthropic/alwaysLoad': true },
    },
    async ({ verbose }) => {
      refreshAccountSetIfStale();
      const set = registry.accountSet();
      const health: AccountHealthDeps = { ...deps, accounts: () => set };
      const reports = set.aliases.map((alias) => deriveAccountHealth(alias, health));
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              defaultAccount: set.defaultAccount ?? null,
              defaultAccountSource: set.defaultAccountSource ?? null,
              accounts: verbose ? reports : reports.map((r) => summarizeAccountHealth(r, r.alias === set.defaultAccount)),
            }),
          },
        ],
      };
    },
  );
}
