import { describe, it, expect } from 'vitest';
import { SERVICES, GENERATED_GATES } from '../src/services.js';
import type { AccountSet } from '../src/accounts.js';

// Service gates evaluate against the PASSED account set, so a forms-scoped
// tenant registers forms_* while a sibling without the bundle does not.

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

describe('per-set service gates', () => {
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

  it('classroom accepts the read-only bundle too', () => {
    const gate = GENERATED_GATES.classroom.enabled;
    expect(gate(setWith({ bundles: ['classroom'] }))).toBe(true);
    expect(gate(setWith({ bundles: ['classroom_readonly'] }))).toBe(true);
    expect(gate(setWith({}))).toBe(false);
    expect(GENERATED_GATES.classroom.hint).toContain('classroom_readonly');
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
