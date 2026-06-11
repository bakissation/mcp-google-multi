import { describe, it, expect } from 'vitest';
import { deriveAccountHealth, type AccountHealthDeps } from '../src/tools/accounts-tool.js';
import { resolveScopesForAccount } from '../src/auth.js';

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
  it('reports missing with an auth hint when no token file exists', () => {
    const h = deriveAccountHealth(ALIAS, deps({ hasToken: () => false }));
    expect(h.token.status).toBe('missing');
    expect(h.token.hint).toContain('auth --account test');
    expect(h.scopes).toEqual({ configured: CONFIGURED.length, granted: 0, missing: CONFIGURED });
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
    expect(h.scopes.missing).toEqual(CONFIGURED.slice(2));
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
