import { describe, it, expect } from 'vitest';
import { BUNDLE_CATALOG } from '../src/scope-catalog.js';
import { classifyScope, bundleForMethodScopes } from '../src/scope-observability.js';

const C = 'https://www.googleapis.com/auth/classroom.';

describe('classroom bundles', () => {
  it('the read-only bundle holds no write scope', () => {
    const scopes = BUNDLE_CATALOG.classroom_readonly.scopes;
    expect(scopes.length).toBeGreaterThan(0);
    for (const s of scopes) {
      expect(s.startsWith(C)).toBe(true);
      expect(/readonly$|profile\.emails$/.test(s)).toBe(true);
    }
    expect(BUNDLE_CATALOG.classroom_readonly.risk).toBe('low');
  });

  it('the read-write bundle carries the submission and profile reads that tools need', () => {
    const scopes = BUNDLE_CATALOG.classroom.scopes;
    expect(scopes).toContain(`${C}student-submissions.students.readonly`);
    expect(scopes).toContain(`${C}profile.emails`);
  });

  it('a read method points at the read-only bundle, a write method at the full one', () => {
    expect(bundleForMethodScopes([`${C}courses`, `${C}courses.readonly`])).toBe('classroom_readonly');
    expect(bundleForMethodScopes([`${C}courses`])).toBe('classroom');
  });

  it('a method on base scopes needs no bundle', () => {
    expect(bundleForMethodScopes(['https://www.googleapis.com/auth/drive'])).toBeUndefined();
    expect(bundleForMethodScopes([])).toBeUndefined();
  });

  it('a scope held by both bundles is hinted with the read-only one', () => {
    const c = classifyScope(`${C}student-submissions.students.readonly`, new Set(), new Set());
    expect(c).toMatchObject({ state: 'not_requestable', bundle: 'classroom_readonly', alsoIn: ['classroom'] });
  });
});
