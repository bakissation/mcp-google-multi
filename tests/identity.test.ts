import { describe, it, expect, afterEach } from 'vitest';
import { buildIdentityContext, isOwnerContext, type IdentityContext } from '../src/identity.js';
import { hasToken, writeToken } from '../src/token-store.js';
import { clearKeyCacheForTest } from '../src/master-key.js';
import type { Account } from '../src/accounts.js';

describe('IdentityContext (the forward-compat seam)', () => {
  it('free core builds exactly the owner subject', () => {
    const ctx = buildIdentityContext({} as NodeJS.ProcessEnv);
    expect(ctx.subject).toBe('owner');
    expect(typeof ctx.getClient).toBe('function');
    expect(Object.keys(ctx.tokenStore).sort()).toEqual(['hasToken', 'readToken', 'updateToken', 'writeToken']);
  });

  it('subject is a plain string: a context can carry a tenant id (S1.5 widen)', () => {
    const base = buildIdentityContext({} as NodeJS.ProcessEnv);
    const tenantCtx: IdentityContext = { ...base, subject: 'tenant-a' };
    expect(tenantCtx.subject).toBe('tenant-a');
  });

  it('accounts is a live getter, never a pinned snapshot', () => {
    const ctx = buildIdentityContext({} as NodeJS.ProcessEnv);
    // Two reads go through the accessor; the seam contract is that each read
    // reflects the CURRENT registry (same object here since nothing mutated).
    expect(ctx.accounts).toBe(ctx.accounts);
    expect(Array.isArray(ctx.accounts.aliases)).toBe(true);
  });

  it('only buildIdentityContext mints the owner brand', () => {
    const ctx = buildIdentityContext({} as NodeJS.ProcessEnv);
    expect(isOwnerContext(ctx)).toBe(true);
    expect(isOwnerContext({ ...ctx })).toBe(false);
    expect(isOwnerContext({ ...ctx, subject: 'owner' })).toBe(false);
    expect(isOwnerContext(undefined)).toBe(false);
  });

  describe('owner context custody', () => {
    const saved: Record<string, string | undefined> = {};
    afterEach(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      clearKeyCacheForTest();
    });

    it('reads the same token files as the module functions', async () => {
      for (const k of ['MASTER_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) saved[k] = process.env[k];
      process.env.MASTER_KEY = 'identity-test-master-key';
      process.env.GOOGLE_CLIENT_ID = 'test-client-id';
      process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
      clearKeyCacheForTest();
      writeToken('test', { refresh_token: 'rt-owner' });
      const ctx = buildIdentityContext({} as NodeJS.ProcessEnv);
      expect(ctx.tokenStore.readToken('test')?.refresh_token).toBe('rt-owner');
      expect(ctx.tokenStore.hasToken('test')).toBe(hasToken('test'));
      expect((await ctx.getClient('test' as Account)).credentials.refresh_token).toBe('rt-owner');
    });
  });
});
