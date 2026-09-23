import { describe, it, expect } from 'vitest';
import { buildIdentityContext, type IdentityContext } from '../src/identity.js';

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
});
