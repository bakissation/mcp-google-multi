import { describe, it, expect } from 'vitest';
import { addFormSchema, validateAddForm, scopeGrantDiff, allOptionalBundles, argsToAddForm, urlElicitationParams } from '../src/tools/account-wizard.js';
import { specTypeSchemas } from '@modelcontextprotocol/server';

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
      expect(r.message).toContain('"form"');
      expect(r.hint).toContain('Did you mean "forms"?');
    }
  });

  it('rejects an Object.prototype member name as an unknown bundle', () => {
    for (const name of ['constructor', 'toString']) {
      const r = validateAddForm({ alias: 'work', email: 'a@b.com', otherBundles: name }, existing);
      expect(r.ok, name).toBe(false);
      if (!r.ok) expect(r.slug).toBe('E_UNKNOWN_BUNDLE');
    }
  });

  it('rejects "admin" as a bundle (use the checkbox)', () => {
    const r = validateAddForm({ alias: 'work', email: 'a@b.com', otherBundles: 'admin' }, existing);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.slug).toBe('E_UNKNOWN_BUNDLE');
  });
});

describe('argsToAddForm (argument-mode fallback)', () => {
  it('maps CSV bundles through otherBundles and validates end to end', () => {
    const v = validateAddForm(argsToAddForm({ alias: 'work', email: 'a@b.c', bundles: 'forms, chat' }), []);
    expect(v).toEqual({ ok: true, alias: 'work', email: 'a@b.c', bundles: ['forms', 'chat'], admin: false });
  });

  it('passes allBundles and admin through', () => {
    const v = validateAddForm(argsToAddForm({ alias: 'w', email: 'a@b.c', allBundles: true, admin: true }), []);
    expect(v).toEqual({ ok: true, alias: 'w', email: 'a@b.c', bundles: allOptionalBundles(), admin: true });
  });

  it('a missing email still fails validation', () => {
    const v = validateAddForm(argsToAddForm({ alias: 'work' }), []);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.slug).toBe('E_VALIDATION');
  });

  // Every other tool in the server spells this `account`, so both are accepted.
  it('accepts `account` as a synonym for `alias`, and `alias` wins when both are sent', () => {
    expect(argsToAddForm({ account: 'work', email: 'a@b.c' }).alias).toBe('work');
    expect(argsToAddForm({ alias: 'real', account: 'other', email: 'a@b.c' }).alias).toBe('real');
  });

  it('an unknown bundle still gets the did-you-mean', () => {
    const v = validateAddForm(argsToAddForm({ alias: 'work', email: 'a@b.c', bundles: 'form' }), []);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.slug).toBe('E_UNKNOWN_BUNDLE');
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

describe('elicitation param shapes (validated against the SDK schemas)', () => {
  // Schemas come from the SDK package we DECLARE as a dependency; the
  // core package that defines them is only transitive.
  // The url-mode branch shipped broken because `as never` at the call site
  // disabled every shape check: elicitationId is required, so the request
  // failed client-side validation and the branch always fell through.
  it('url-mode params satisfy ElicitRequestURLParamsSchema', () => {
    const r = specTypeSchemas.ElicitRequestURLParams.safeParse(
      urlElicitationParams('work', 'https://accounts.google.com/o/oauth2/v2/auth?x=1', 'a'.repeat(32)),
    );
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues)).toBe(true);
  });

  it('omitting elicitationId is rejected (the original defect)', () => {
    const { elicitationId: _drop, ...without } = urlElicitationParams('work', 'https://x', 'id');
    expect(specTypeSchemas.ElicitRequestURLParams.safeParse(without).success).toBe(false);
  });

  it('the form-mode params we send satisfy ElicitRequestFormParamsSchema', () => {
    const r = specTypeSchemas.ElicitRequestFormParams.safeParse({
      message: 'Add a Google account',
      requestedSchema: addFormSchema(),
    });
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues)).toBe(true);
  });
});
