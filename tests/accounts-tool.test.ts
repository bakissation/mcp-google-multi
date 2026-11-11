import { describe, it, expect, afterEach } from 'vitest';
import { accountHealthDepsFor, deriveAccountHealth, type AccountHealthDeps } from '../src/tools/accounts-tool.js';
import { setHttpReauthLink } from '../src/reauth-hint.js';
import { setHintProvider, type HintCase } from '../src/hint-provider.js';
import { resolveScopesForAccount } from '../src/auth.js';
import { accountSet, parseResult, toolHarness } from './_tool-harness.js';

const ALIAS = 'test';
const CONFIGURED = resolveScopesForAccount(ALIAS);
const NOW = 1_750_000_000_000;

function deps(overrides: Partial<AccountHealthDeps>): AccountHealthDeps {
  return {
    hasToken: () => true,
    readToken: () => null,
    fileExists: () => false,
    now: () => NOW,
    ...overrides,
  };
}

describe('deriveAccountHealth', () => {
  it('missing-token hint becomes an AS re-auth link over HTTP', () => {
    setHttpReauthLink((a) => `https://mcp.example.com/authorize?flow=alias_reauth&alias=${encodeURIComponent(a)}&exp=1&sig=s`);
    try {
      const h = deriveAccountHealth(ALIAS, deps({ hasToken: () => false }));
      expect(h.token.hint).toContain('https://mcp.example.com/authorize?flow=alias_reauth&alias=test');
      expect(h.token.hint).not.toContain('npx mcp-google-multi');
    } finally {
      setHttpReauthLink(null);
    }
  });

  it('reports missing with an auth hint when no token file exists', () => {
    const h = deriveAccountHealth(ALIAS, deps({ hasToken: () => false }));
    expect(h.token.status).toBe('missing');
    expect(h.token.hint).toContain('auth --account test');
    expect(h.scopes).toMatchObject({ configured: CONFIGURED.length, granted: 0 });
    // missing kept for v5 consumers, now sorted; three-state
    // breakdown present.
    expect(h.scopes.missing).toEqual([...CONFIGURED].sort());
    expect(h.scopes.requestable).toEqual([...CONFIGURED].sort());
    expect(h.scopes.callable).toEqual([]);
    expect(h.email).toBe('test@example.com');
  });

  it('hints migrate-tokens when only a legacy plaintext token exists', () => {
    const h = deriveAccountHealth(ALIAS, deps({ hasToken: () => false, fileExists: () => true }));
    expect(h.token.status).toBe('missing');
    expect(h.token.hint).toContain('migrate-tokens');
  });

  it('reports decrypt_error when readToken throws', () => {
    const h = deriveAccountHealth(
      ALIAS,
      deps({
        readToken: () => {
          throw new Error('Unsupported state or unable to authenticate data');
        },
      }),
    );
    expect(h.token.status).toBe('decrypt_error');
    expect(h.token.hint).toContain('MASTER_KEY');
  });

  it('reports ok with expiry and granted scope diff for a live token', () => {
    const h = deriveAccountHealth(
      ALIAS,
      deps({
        readToken: () => ({
          expiry_date: NOW + 60_000,
          refresh_token: 'r',
          scope: `${CONFIGURED[0]} ${CONFIGURED[1]}`,
        }),
      }),
    );
    expect(h.token.status).toBe('ok');
    expect(h.token.expiryDate).toBe(new Date(NOW + 60_000).toISOString());
    expect(h.scopes.granted).toBe(2);
    expect(h.scopes.missing).toEqual([...CONFIGURED.slice(2)].sort());
  });

  it('reports expired_refreshable when expired but a refresh token exists', () => {
    const h = deriveAccountHealth(
      ALIAS,
      deps({ readToken: () => ({ expiry_date: NOW - 1, refresh_token: 'r', scope: CONFIGURED.join(' ') }) }),
    );
    expect(h.token.status).toBe('expired_refreshable');
    expect(h.scopes.missing).toEqual([]);
  });

  it('reports needs_reauth when expired with no refresh token', () => {
    const h = deriveAccountHealth(ALIAS, deps({ readToken: () => ({ expiry_date: NOW - 1 }) }));
    expect(h.token.status).toBe('needs_reauth');
    expect(h.token.hint).toContain('auth --account test');
  });

  it('treats absent fields defensively (unchecked TokenData cast)', () => {
    const h = deriveAccountHealth(ALIAS, deps({ readToken: () => ({}) }));
    expect(h.token.status).toBe('needs_reauth');
    expect(h.scopes.granted).toBe(0);
    expect(h.token.expiryDate).toBeUndefined();
  });
});

describe('deriveAccountHealth hint provider routing', () => {
  afterEach(() => setHintProvider(null));

  function echo() {
    const seen: HintCase[] = [];
    setHintProvider({
      render: (c) => {
        seen.push(c);
        return { hint: `kind:${c.kind}` };
      },
    });
    return seen;
  }

  it('missing (no legacy file) renders reauth', () => {
    const seen = echo();
    const h = deriveAccountHealth(ALIAS, deps({ hasToken: () => false }));
    expect(h.token.hint).toBe('kind:reauth');
    expect(seen).toEqual([{ kind: 'reauth', account: ALIAS }]);
  });

  it('missing (legacy plaintext file present) renders legacy_plaintext_token, not reauth', () => {
    const seen = echo();
    const h = deriveAccountHealth(ALIAS, deps({ hasToken: () => false, fileExists: () => true }));
    expect(h.token.hint).toBe('kind:legacy_plaintext_token');
    expect(seen).toEqual([{ kind: 'legacy_plaintext_token', account: ALIAS }]);
  });

  it('decrypt_error renders token_unreadable', () => {
    const seen = echo();
    const h = deriveAccountHealth(ALIAS, deps({ readToken: () => { throw new Error('nope'); } }));
    expect(h.token.hint).toBe('kind:token_unreadable');
    expect(seen).toEqual([{ kind: 'token_unreadable', account: ALIAS }]);
  });

  it('needs_reauth renders reauth', () => {
    const seen = echo();
    const h = deriveAccountHealth(ALIAS, deps({ readToken: () => ({ expiry_date: NOW - 1 }) }));
    expect(h.token.hint).toBe('kind:reauth');
    expect(seen).toEqual([{ kind: 'reauth', account: ALIAS }]);
  });

  it('a live token with scopes still missing renders scopes_missing', () => {
    const seen = echo();
    const h = deriveAccountHealth(
      ALIAS,
      deps({ readToken: () => ({ expiry_date: NOW + 60_000, refresh_token: 'r', scope: CONFIGURED[0] }) }),
    );
    expect(h.token.hint).toBe('kind:scopes_missing');
    expect(seen).toEqual([{ kind: 'scopes_missing', account: ALIAS }]);
  });
});

describe('account_list (registered tool)', () => {
  const ACCOUNTS = accountSet(
    { work: { email: 'work@example.com', admin: true }, home: { email: 'home@example.com' } },
    { defaultAccount: 'work' },
  );

  it('is terse by default: alias, email, admin, token status, default flag only', async () => {
    const { call } = toolHarness({ accounts: ACCOUNTS });
    const payload = parseResult(await call('account_list', {}));
    expect(payload.accounts).toEqual([
      { alias: 'work', email: 'work@example.com', admin: true, tokenStatus: 'ok', default: true },
      { alias: 'home', email: 'home@example.com', admin: false, tokenStatus: 'ok', default: false },
    ]);
  });

  it('marks a read-only admin account with adminLevel and leaves full admins unmarked', async () => {
    const set = accountSet(
      { ro: { email: 'ro@example.com', scopeProfile: 'ro' }, full: { email: 'full@example.com', admin: true } },
      { defaultAccount: 'full', scopeProfiles: { ro: { bundles: ['admin_readonly'] } } },
    );
    const { call } = toolHarness({ accounts: set });
    const payload = parseResult(await call('account_list', {}));
    expect(payload.accounts).toEqual([
      { alias: 'ro', email: 'ro@example.com', admin: true, adminLevel: 'readonly', tokenStatus: 'ok', default: false },
      { alias: 'full', email: 'full@example.com', admin: true, tokenStatus: 'ok', default: true },
    ]);
  });

  it('verbose: true is byte-identical to deriveAccountHealth\'s own report', async () => {
    const { call, ctx } = toolHarness({ accounts: ACCOUNTS });
    const health = accountHealthDepsFor(ctx.tokenStore, () => ACCOUNTS);
    const expected = ACCOUNTS.aliases.map((alias) => deriveAccountHealth(alias, health));
    const payload = parseResult(await call('account_list', { verbose: true }));
    expect(payload).toEqual({
      defaultAccount: 'work',
      defaultAccountSource: 'config',
      accounts: expected,
    });
  });
});
