import * as fs from 'node:fs';
import type { ToolRegistry } from '../registry.js';
import { ACCOUNTS, ACCOUNT_CONFIG } from '../accounts.js';
import { getAdminAccounts, resolveScopesForAccount } from '../auth.js';
import { hasToken, readToken } from '../token-store.js';

export interface AccountHealthDeps {
  hasToken: (alias: string) => boolean;
  readToken: (alias: string) => { expiry_date?: number; refresh_token?: string; scope?: string } | null;
  fileExists: (p: string) => boolean;
  now: () => number;
}

const DEFAULT_DEPS: AccountHealthDeps = {
  hasToken,
  readToken,
  fileExists: fs.existsSync,
  now: Date.now,
};

export type TokenStatus = 'ok' | 'expired_refreshable' | 'needs_reauth' | 'missing' | 'decrypt_error';

export interface AccountHealth {
  alias: string;
  email: string;
  admin: boolean;
  token: { status: TokenStatus; expiryDate?: string; hint?: string };
  scopes: { configured: number; granted: number; missing: string[] };
}

export function deriveAccountHealth(alias: string, deps: AccountHealthDeps = DEFAULT_DEPS): AccountHealth {
  const config = ACCOUNT_CONFIG[alias];
  const admin = getAdminAccounts().includes(alias);
  const configured = resolveScopesForAccount(alias);
  const base = { alias, email: config.email, admin };
  const noScopes = { configured: configured.length, granted: 0, missing: configured };

  if (!deps.hasToken(alias)) {
    const legacy = deps.fileExists(config.tokenPath);
    return {
      ...base,
      token: {
        status: 'missing',
        hint: legacy
          ? 'Plaintext token.json found — run: npx mcp-google-multi migrate-tokens'
          : `Run: npx mcp-google-multi auth --account ${alias}`,
      },
      scopes: noScopes,
    };
  }

  let token: ReturnType<AccountHealthDeps['readToken']>;
  try {
    token = deps.readToken(alias);
  } catch {
    return {
      ...base,
      token: { status: 'decrypt_error', hint: 'Wrong MASTER_KEY or corrupt token file — re-auth or restore the key.' },
      scopes: noScopes,
    };
  }

  const granted = typeof token?.scope === 'string' ? token.scope.split(' ').filter(Boolean) : [];
  const missing = configured.filter((s) => !granted.includes(s));
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
          ? `Run: npx mcp-google-multi auth --account ${alias}`
          : missing.length > 0
            ? 'Re-auth to grant the missing scopes'
            : undefined,
    },
    scopes: { configured: configured.length, granted: granted.length, missing },
  };
}

export function registerAccountTools(registry: ToolRegistry, deps: AccountHealthDeps = DEFAULT_DEPS): void {
  registry.registerMeta(
    'account_list',
    {
      description:
        'List the configured Google accounts: alias, email, admin flag, token health ' +
        '(ok / expired_refreshable / needs_reauth / missing / decrypt_error), and granted vs configured scopes. ' +
        'Use this to see which account aliases are available and healthy.',
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ accounts: ACCOUNTS.map((alias) => deriveAccountHealth(alias, deps)) }),
        },
      ],
    }),
  );
}
