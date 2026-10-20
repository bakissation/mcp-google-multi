import { describe, it, expect } from 'vitest';
import { isAllowed, denyReason, privilegeOf, writeDisabledResult, type Policy } from '../src/write-control.js';

const safe = (over: Partial<Policy> = {}): Policy =>
  ({ profile: 'safe-writes', readOnly: false, allow: [], deny: [], ...over });
const full = (): Policy => ({ profile: 'full-writes', readOnly: false, allow: [], deny: [] });

const S = (n: string) => `https://www.googleapis.com/auth/${n}`;

// Shapes taken from the real registry entries.
const MAKE_ADMIN = { name: 'admin_users_make_admin', service: 'admin', cud: 'update' as const, scopes: [S('admin.directory.user')] };
const RUN_SCRIPT = { name: 'script_scripts_run', service: 'script', cud: 'create' as const, scopes: [S('script.projects'), S('drive')] };
const GMAIL_WATCH = { name: 'gmail_users_watch', service: 'gmail', cud: 'create' as const, scopes: [S('gmail.modify')] };
const GMAIL_SEND = { name: 'gmail_send', service: 'gmail', cud: 'create' as const, scopes: [S('gmail.send')] };
const SHEETS_WRITE = { name: 'sheets_write_range', service: 'sheets', cud: 'update' as const, scopes: [S('spreadsheets')] };
// forms.forms.watches.create/renew generate as _watches_create/_watches_renew
// (plural "watches"), unlike every other API's singular *.watch -> _watch.
const FORMS_WATCHES_CREATE = { name: 'forms_forms_watches_create', service: 'forms', cud: 'create' as const, scopes: [S('forms.body')] };
const FORMS_WATCHES_RENEW = { name: 'forms_forms_watches_renew', service: 'forms', cud: 'update' as const, scopes: [S('forms.body')] };
// .delete only cancels an existing registration (no new external URL
// gains anything); it is not, and should not be, flagged.
const FORMS_WATCHES_DELETE = { name: 'forms_forms_watches_delete', service: 'forms', cud: 'delete' as const, scopes: [S('forms.body')] };

describe('safe-writes refuses privileged writes whatever the verb', () => {
  it('blocks an org-wide update that looks like an ordinary update', () => {
    expect(isAllowed(MAKE_ADMIN, safe())).toBe(false);
    expect(privilegeOf(MAKE_ADMIN)).toBe('privileged_scope');
  });

  // The scope list is an any-of, so one privileged alternative is enough.
  it('blocks arbitrary code execution even though drive is an alternative scope', () => {
    expect(isAllowed(RUN_SCRIPT, safe())).toBe(false);
    expect(privilegeOf(RUN_SCRIPT)).toBe('privileged_scope');
  });

  // The scope is plain gmail.modify; only the operation gives it away.
  it('blocks push registration, which no scope marks as privileged', () => {
    expect(isAllowed(GMAIL_WATCH, safe())).toBe(false);
    expect(privilegeOf(GMAIL_WATCH)).toBe('push_registration');
  });

  // LOW (item 12): forms' plural "watches" resource generates a different
  // name shape than every other API's *.watch, so it needs its own branch
  // in PUSH_REGISTRATION_RE alongside the common _watch suffix.
  it('blocks forms_forms_watches_create and _renew too, despite the non-standard name shape', () => {
    expect(isAllowed(FORMS_WATCHES_CREATE, safe())).toBe(false);
    expect(privilegeOf(FORMS_WATCHES_CREATE)).toBe('push_registration');
    expect(isAllowed(FORMS_WATCHES_RENEW, safe())).toBe(false);
    expect(privilegeOf(FORMS_WATCHES_RENEW)).toBe('push_registration');
  });

  // ROUND 6: forms_forms_watches_create is a GENERATED tool, so in the real
  // registry it never reaches isAllowed() at all any more (it is the escape
  // hatch now: see tests/google-api.test.ts and tests/_escape-hatch.test.ts
  // for its deny/ask/allow behavior). isAllowed() itself is back to its
  // plain pre-round-5 form; this push-registration-vs-allow-glob interaction
  // is no longer something isAllowed() is responsible for.

  it('an ordinary create tool (not a push registration) is unaffected: forms:create still allows it', () => {
    const ordinary = { name: 'forms_create', service: 'forms', cud: 'create' as const, scopes: [S('forms.body')] };
    expect(privilegeOf(ordinary)).toBeUndefined();
    expect(isAllowed(ordinary, safe({ allow: ['forms:create'] }))).toBe(true);
  });

  it('does not flag forms_forms_watches_delete as a push registration: cancelling one grants nothing', () => {
    // Unrelated to this: safe-writes refuses deletes generically, so this
    // is not expected to be allowed either; only that it is refused as an
    // ordinary delete, not specifically as a privileged push registration.
    expect(privilegeOf(FORMS_WATCHES_DELETE)).toBeUndefined();
    expect(denyReason(FORMS_WATCHES_DELETE, safe())?.rule).not.toBe('privileged');
  });

  it('still permits ordinary user-data writes', () => {
    expect(isAllowed(GMAIL_SEND, safe())).toBe(true);
    expect(isAllowed(SHEETS_WRITE, safe())).toBe(true);
  });

  it('leaves full-writes untouched', () => {
    for (const t of [MAKE_ADMIN, RUN_SCRIPT, GMAIL_WATCH]) expect(isAllowed(t, full())).toBe(true);
  });

  it('never gates a read, privileged scope or not', () => {
    const read = { ...MAKE_ADMIN, name: 'admin_users_list', cud: 'read' as const };
    expect(isAllowed(read, safe())).toBe(true);
    expect(denyReason(read, safe())).toBeUndefined();
  });
});

describe('the gate fails toward working, not toward blocking', () => {
  // A tool whose scopes are unknown must not be refused: an absent list is
  // missing information, not evidence of privilege.
  it('treats an absent scope list as not privileged', () => {
    const unknown = { name: 'sheets_append_rows', service: 'sheets', cud: 'create' as const };
    expect(privilegeOf(unknown)).toBeUndefined();
    expect(isAllowed(unknown, safe())).toBe(true);
  });

  it('treats an empty scope list as not privileged', () => {
    expect(isAllowed({ ...SHEETS_WRITE, scopes: [] }, safe())).toBe(true);
  });
});

describe('an explicit allow still wins, because it is a deliberate opt-in', () => {
  // The op is everything after the FIRST underscore, so admin_users_make_admin
  // is "admin:users_make_admin"; "admin:make_admin" matches nothing.
  it('GOOGLE_WRITE_ALLOW overrides the privileged gate', () => {
    expect(isAllowed(MAKE_ADMIN, safe({ allow: ['admin:users_make_admin'] }))).toBe(true);
  });

  it('but deny still beats an allow', () => {
    expect(isAllowed(MAKE_ADMIN, safe({ allow: ['admin:*'], deny: ['admin:users_make_admin'] }))).toBe(false);
  });
});

describe('the refusal explains privilege rather than blaming the verb', () => {
  const hintOf = (t: typeof MAKE_ADMIN, p: Policy) =>
    JSON.parse(writeDisabledResult(t, p).content[0].text).hint as string;

  it('says what makes it privileged, not "delete is not permitted"', () => {
    expect(denyReason(MAKE_ADMIN, safe())).toEqual({ rule: 'privileged', profile: 'safe-writes', kind: 'privileged_scope' });
    const h = hintOf(MAKE_ADMIN, safe());
    expect(h).toContain('whole organization');
    expect(h).toContain('full-writes');
    expect(h).not.toContain('does not permit update');
  });

  it('names the export risk for a push channel', () => {
    expect(hintOf(GMAIL_WATCH, safe())).toContain('external URL');
  });

  // Same contract as every other deny hint: the pattern it suggests must work.
  it('suggests an allow pattern that actually permits the call', () => {
    for (const t of [MAKE_ADMIN, GMAIL_WATCH]) {
      const suggested = hintOf(t, safe()).match(/GOOGLE_WRITE_ALLOW="([^"]+)"/)?.[1];
      expect(suggested, t.name).toBeTruthy();
      expect(isAllowed(t, safe({ allow: [suggested!] })), t.name).toBe(true);
    }
  });
});
