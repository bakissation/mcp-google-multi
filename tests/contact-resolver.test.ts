import { describe, it, expect } from 'vitest';
import { resolveContacts, type ResolveCandidate } from '../src/tools/contacts.js';

function cand(p: Partial<ResolveCandidate> & { displayName: string; email?: string }): ResolveCandidate {
  return {
    resourceName: p.resourceName ?? `people/${p.displayName}-${p.email ?? 'x'}`,
    displayName: p.displayName,
    source: p.source ?? 'contacts',
    emails: p.emails ?? (p.email ? [{ value: p.email }] : []),
    hasOrg: p.hasOrg ?? false,
  };
}

describe('resolveContacts (A10 tie-break)', () => {
  it('exact name beats prefix match', () => {
    const out = resolveContacts(
      [cand({ displayName: 'Rymond', email: 'rymond@x.com' }), cand({ displayName: 'Rym', email: 'rym@x.com' })],
      'Rym', 5,
    );
    expect(out.resolved?.email).toBe('rym@x.com');
    expect(out.ambiguous).toBeUndefined();
  });

  it('accent-folds the name comparison (Rÿm == Rym)', () => {
    const out = resolveContacts(
      [cand({ displayName: 'Rÿm', email: 'accent@x.com' }), cand({ displayName: 'Rymond', email: 'p@x.com' })],
      'Rym', 5,
    );
    expect(out.resolved?.email).toBe('accent@x.com');
  });

  it('saved connection beats an other-contact when names tie', () => {
    const out = resolveContacts(
      [
        cand({ displayName: 'Rym', email: 'other@x.com', source: 'otherContacts' }),
        cand({ displayName: 'Rym', email: 'saved@x.com', source: 'contacts' }),
      ],
      'Rym', 5,
    );
    expect(out.resolved?.email).toBe('saved@x.com');
    expect(out.resolved?.source).toBe('contacts');
  });

  it('returns ambiguous (capped) when a real tie survives all rules', () => {
    const out = resolveContacts(
      [
        cand({ displayName: 'Rym', email: 'rym1@x.com' }),
        cand({ displayName: 'Rym', email: 'rym2@x.com' }),
        cand({ displayName: 'Rym', email: 'rym3@x.com' }),
      ],
      'Rym', 2,
    );
    expect(out.ambiguous).toBe(true);
    expect(out.candidates).toHaveLength(2); // capped to maxCandidates
    expect(out.resolved).toBeUndefined();
  });

  it('recall: an other-contact-only match still resolves', () => {
    const out = resolveContacts(
      [cand({ displayName: 'Faycal', email: 'faycal@auto.com', source: 'otherContacts' })],
      'Faycal', 5,
    );
    expect(out.resolved?.email).toBe('faycal@auto.com');
    expect(out.resolved?.source).toBe('otherContacts');
  });

  it('picks the primary email within a chosen contact (else type order)', () => {
    const out = resolveContacts(
      [cand({ displayName: 'Rym', emails: [
        { value: 'home@x.com', type: 'home' },
        { value: 'canon@x.com', primary: true },
        { value: 'work@x.com', type: 'work' },
      ] })],
      'Rym', 5,
    );
    expect(out.resolved?.email).toBe('canon@x.com');
  });

  it('no candidates → resolved:null (not an error)', () => {
    expect(resolveContacts([], 'Nobody', 5)).toEqual({ query: 'Nobody', resolved: null });
  });

  it('candidates with no email are dropped → resolved:null', () => {
    const out = resolveContacts([cand({ displayName: 'Rym', emails: [] })], 'Rym', 5);
    expect(out).toEqual({ query: 'Rym', resolved: null });
  });

  it('a fuller record (has org) breaks a name/source tie', () => {
    const out = resolveContacts(
      [
        cand({ displayName: 'Rym', email: 'bare@x.com' }),
        cand({ displayName: 'Rym', email: 'full@x.com', hasOrg: true }),
      ],
      'Rym', 5,
    );
    expect(out.resolved?.email).toBe('full@x.com');
  });
});
