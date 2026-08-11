import { describe, it, expect } from 'vitest';
import { planReset } from '../src/doctor.js';

const state = (aliases: string[], withTokens: string[]) => ({
  aliases,
  tokenPresent: (a: string) => withTokens.includes(a),
});

describe('planReset (B6)', () => {
  it('rejects an unknown --account', () => {
    const r = planReset({ account: 'nope', regenerateKey: false, yes: true }, state(['ic', 'personal'], ['ic']));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.slug).toBe('E_VALIDATION');
  });

  it('default wipes all accounts; reauth lists only those that had tokens', () => {
    const r = planReset({ regenerateKey: false, yes: true }, state(['ic', 'personal', 'fatoura'], ['ic', 'personal']));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.wipeAliases).toEqual(['ic', 'personal', 'fatoura']);
      expect(r.reauth).toEqual(['ic', 'personal']); // fatoura had no token
    }
  });

  it('--account scopes the wipe to one alias', () => {
    const r = planReset({ account: 'personal', regenerateKey: false, yes: true }, state(['ic', 'personal'], ['ic', 'personal']));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.wipeAliases).toEqual(['personal']);
      expect(r.reauth).toEqual(['personal']);
    }
  });

  it('--regenerate-key is allowed with a full (all-accounts) wipe', () => {
    const r = planReset({ regenerateKey: true, yes: true }, state(['ic', 'personal'], ['ic', 'personal']));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.regenerateKey).toBe(true);
  });

  it('--regenerate-key is REFUSED when another account still holds a token (brick guard)', () => {
    const r = planReset({ account: 'personal', regenerateKey: true, yes: true }, state(['ic', 'personal'], ['ic', 'personal']));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.slug).toBe('E_KEY_REGEN_BLOCKED');
      expect(r.message).toContain('ic');
    }
  });

  it('--regenerate-key with --account is allowed when no OTHER account has a token', () => {
    const r = planReset({ account: 'personal', regenerateKey: true, yes: true }, state(['ic', 'personal'], ['personal']));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.regenerateKey).toBe(true);
  });
});
