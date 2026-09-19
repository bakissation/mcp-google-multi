import { describe, it, expect } from 'vitest';
import { addFormSchema, validateAddForm, scopeGrantDiff, allOptionalBundles } from '../src/tools/account-wizard.js';

describe('addFormSchema', () => {
  it('is a flat object schema with alias+email required and bundle checkboxes', () => {
    const s = addFormSchema() as any;
    expect(s.type).toBe('object');
    expect(Object.keys(s.properties)).toEqual(['alias', 'email', 'allBundles', 'forms', 'chat', 'otherBundles', 'admin']);
    expect(s.required).toEqual(['alias', 'email']);
    expect(s.properties.allBundles.type).toBe('boolean'); // "all optional scopes" checkbox
    expect(s.properties.forms.type).toBe('boolean'); // checklist, not CSV
    expect(s.properties.chat.type).toBe('boolean');
    // MCP elicitation forbids nested/array fields — all primitives.
    for (const p of Object.values(s.properties) as any[]) {
      expect(['string', 'boolean']).toContain(p.type);
    }
  });
});

describe('validateAddForm', () => {
  const existing = ['ic', 'personal'];

  it('accepts a clean row and collects checkbox bundles', () => {
    const r = validateAddForm({ alias: 'work', email: 'a@b.com', forms: true, chat: true, admin: false }, existing);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.alias).toBe('work');
      expect(r.bundles.sort()).toEqual(['chat', 'forms']);
      expect(r.admin).toBe(false);
    }
  });

  it('merges checkboxes with otherBundles, deduped', () => {
    const r = validateAddForm({ alias: 'work', email: 'a@b.com', forms: true, otherBundles: 'slides, forms' }, existing);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bundles.sort()).toEqual(['forms', 'slides']);
  });

  it('base-only when nothing selected', () => {
    const r = validateAddForm({ alias: 'work', email: 'a@b.com' }, existing);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bundles).toEqual([]);
  });

  it('allBundles grants every optional bundle and supersedes individual picks', () => {
    const r = validateAddForm({ alias: 'work', email: 'a@b.com', allBundles: true, forms: false }, existing);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bundles.sort()).toEqual(allOptionalBundles().sort());
      expect(r.bundles).not.toContain('admin'); // admin stays its own checkbox
      expect(r.bundles.length).toBeGreaterThan(10);
    }
  });

  it('rejects a bad alias', () => {
    const r = validateAddForm({ alias: 'has space', email: 'a@b.com' }, existing);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.slug).toBe('E_VALIDATION');
  });

  it('rejects a duplicate alias with E_ALIAS_EXISTS', () => {
    const r = validateAddForm({ alias: 'ic', email: 'a@b.com' }, existing);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.slug).toBe('E_ALIAS_EXISTS');
  });

  it('requires an email', () => {
    const r = validateAddForm({ alias: 'work', email: '  ' }, existing);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.slug).toBe('E_VALIDATION');
  });

  it('rejects an unknown otherBundles entry with a did-you-mean', () => {
    const r = validateAddForm({ alias: 'work', email: 'a@b.com', otherBundles: 'form' }, existing);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.slug).toBe('E_UNKNOWN_BUNDLE');
      expect(r.message).toContain('forms');
    }
  });

  it('rejects "admin" as a bundle (use the checkbox)', () => {
    const r = validateAddForm({ alias: 'work', email: 'a@b.com', otherBundles: 'admin' }, existing);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.slug).toBe('E_UNKNOWN_BUNDLE');
  });
});

describe('scopeGrantDiff (BR5)', () => {
  it('returns the requested scopes that were not granted', () => {
    const requested = ['a', 'b', 'c'];
    expect(scopeGrantDiff(requested, 'a c')).toEqual(['b']);
  });
  it('empty when all granted', () => {
    expect(scopeGrantDiff(['a', 'b'], 'a b extra')).toEqual([]);
  });
  it('all missing when scope absent', () => {
    expect(scopeGrantDiff(['a', 'b'], undefined)).toEqual(['a', 'b']);
  });
});
