import { describe, it, expect } from 'vitest';
import { SERVICES, GENERATED_GATES } from '../src/services.js';
import type { AccountSet } from '../src/accounts.js';

// S1.11: service gates evaluate against the PASSED account set (a tenant's
// view), so a forms-scoped tenant registers forms_* while a sibling without
// the bundle does not — from the same process.

const setWith = (opts: { bundles?: string[]; admin?: boolean } = {}): AccountSet =>
  ({
    aliases: ['work'],
    configs: {
      work: {
        email: 'work@x.example',
        tokenPath: '/x/work/token.json',
        encPath: '/x/work.enc',
        scopeProfile: 'p',
        admin: opts.admin,
        source: 'env' as const,
      },
    },
    scopeProfiles: { base: { bundles: [] }, p: { bundles: opts.bundles ?? [] } },
    source: 'env',
    stamp: 'env:0',
  }) as AccountSet;

const gateFor = (name: string) => SERVICES.find((s) => s.name === name)!.enabled!;

describe('per-set service gates (S1.11)', () => {
  it('a forms-scoped set enables forms; a sibling without the bundle does not', () => {
    const forms = gateFor('forms');
    expect(forms(setWith({ bundles: ['forms'] }))).toBe(true);
    expect(forms(setWith({ bundles: ['slides'] }))).toBe(false);
  });

  it('analytics accepts either bundle flavor, per set', () => {
    const analytics = gateFor('analytics');
    expect(analytics(setWith({ bundles: ['analytics'] }))).toBe(true);
    expect(analytics(setWith({ bundles: ['analytics_write'] }))).toBe(true);
    expect(analytics(setWith({}))).toBe(false);
  });

  it('admin gates on the SET\'s admin accounts, not the global registry', () => {
    const admin = gateFor('admin');
    expect(admin(setWith({ admin: true }))).toBe(true);
    expect(admin(setWith({}))).toBe(false);
  });

  it('generated gates take the set too', () => {
    expect(GENERATED_GATES.keep.enabled(setWith({ bundles: ['keep'] }))).toBe(true);
    expect(GENERATED_GATES.keep.enabled(setWith({ bundles: ['vault'] }))).toBe(false);
  });

  it('omitting the set falls back to the global registry (free-core default)', () => {
    // the sandboxed global registry has no optional bundles configured
    expect(gateFor('forms')()).toBe(false);
    expect(GENERATED_GATES.keep.enabled()).toBe(false);
  });
});
