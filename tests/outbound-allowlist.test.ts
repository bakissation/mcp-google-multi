import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  checkOutbound,
  checkOutboundForMethod,
  collectBodyRecipients,
  outboundViolations,
  resolveOutboundAllowlist,
} from '../src/outbound-allowlist.js';
import { setHintProvider } from '../src/hint-provider.js';
import { GENERATED_METHOD_TOOLS } from '../src/tools/generated/method-map.js';
import { inferCud } from '../src/registry.js';
import { toolHarness, parseResult, type GoogleRequest } from './_tool-harness.js';

const ENV = { GOOGLE_OUTBOUND_ALLOWLIST: 'a@corp.com, @corp.com , Boss@Partner.io' };

describe('resolveOutboundAllowlist', () => {
  it('is off (null) when unset or empty', () => {
    expect(resolveOutboundAllowlist({})).toBeNull();
    expect(resolveOutboundAllowlist({ GOOGLE_OUTBOUND_ALLOWLIST: '  ' })).toBeNull();
    expect(resolveOutboundAllowlist({ GOOGLE_OUTBOUND_ALLOWLIST: ' , ,' })).toBeNull();
  });

  it('matches exact addresses case-insensitively and trimmed', () => {
    const l = resolveOutboundAllowlist(ENV)!;
    expect(l.allows('A@CORP.com')).toBe(true);
    expect(l.allows(' boss@partner.io ')).toBe(true);
    expect(l.allows('other@partner.io')).toBe(false);
  });

  it('matches @domain entries as a full-domain suffix, never lookalikes or subdomains', () => {
    const l = resolveOutboundAllowlist(ENV)!;
    expect(l.allows('anyone@corp.com')).toBe(true);
    expect(l.allows('evil@notcorp.com')).toBe(false);
    expect(l.allows('x@sub.corp.com')).toBe(false);
  });
});

describe('outboundViolations / checkOutbound', () => {
  it('is a no-op when the feature is off', () => {
    expect(outboundViolations(['anything@anywhere.io'], {})).toEqual([]);
    expect(checkOutbound('x', ['anything@anywhere.io'], 'a', {})).toBeNull();
  });

  it('returns only the rejected addresses', () => {
    expect(outboundViolations(['a@corp.com', 'bad@evil.io', 'ok@corp.com'], ENV)).toEqual(['bad@evil.io']);
  });

  it('the envelope carries the slug, the blocked target and the operator hint', () => {
    const r = checkOutbound('gmail recipient', ['bad@evil.io'], 'work', ENV)!;
    const j = JSON.parse(r.content[0].text);
    expect(j.error).toBe('recipient_not_allowed');
    expect(j.message).toContain('bad@evil.io');
    expect(j.hint).toContain('@corp.com');
    expect(j.retriable).toBe(false);
    expect(j.account).toBe('work');
  });

  it('a hint provider renders outbound_denied with the kind, the target and the entries', () => {
    const seen: unknown[] = [];
    setHintProvider({
      render: (c) => {
        seen.push(c);
        return { hint: `kind:${c.kind}` };
      },
    });
    try {
      const r = checkOutbound('gmail recipient', ['bad@evil.io'], 'work', ENV)!;
      const j = JSON.parse(r.content[0].text);
      expect(j.hint).toBe('kind:outbound_denied');
      expect(seen).toEqual([{
        kind: 'outbound_denied',
        what: 'gmail recipient',
        blocked: ['bad@evil.io'],
        entries: ['a@corp.com', '@corp.com', 'boss@partner.io'],
      }]);
    } finally {
      setHintProvider(null);
    }
  });
});

describe('collectBodyRecipients', () => {
  it('finds attendees, grantees and nested email fields', () => {
    const body = {
      attendees: [{ email: 'a@x.io' }, { email: 'b@y.io', optional: true }],
      emailAddress: 'c@z.io',
      nested: { deeper: { email: 'd@w.io' } },
      email: 'not-an-address',
    };
    expect(collectBodyRecipients(body).sort()).toEqual(['a@x.io', 'b@y.io', 'c@z.io', 'd@w.io']);
  });

  it('handles non-object bodies quietly', () => {
    expect(collectBodyRecipients(undefined)).toEqual([]);
    expect(collectBodyRecipients('raw')).toEqual([]);
  });
});

describe('checkOutboundForMethod (escape hatch / generated)', () => {
  it('does nothing when the allowlist is off, raw sends included', () => {
    expect(checkOutboundForMethod('gmail.users.messages.send', { raw: 'x' }, 'a', {})).toBeNull();
  });

  it('refuses uninspectable raw compose methods while active', () => {
    const r = checkOutboundForMethod('gmail.users.messages.send', { raw: 'x' }, 'a', ENV)!;
    const j = JSON.parse(r.content[0].text);
    expect(j.error).toBe('recipient_not_allowed');
    expect(j.hint).toContain('gmail_send');
  });

  it('gates structured bodies by their recipient fields', () => {
    const bad = checkOutboundForMethod('calendar.events.insert', { attendees: [{ email: 'bad@evil.io' }] }, 'a', ENV);
    expect(bad).not.toBeNull();
    const ok = checkOutboundForMethod('calendar.events.insert', { attendees: [{ email: 'a@corp.com' }] }, 'a', ENV);
    expect(ok).toBeNull();
  });
});

// GHSA-9vg8-7mjp-68v5 part A: the generic emailAddress/email key walk missed
// every grantee spelled another way (a Drive permission's type/domain, a
// Gmail delegate/forwarding/send-as email, a filter's forward action, a
// Calendar ACL scope). Each is now checked by its own shape.
describe('checkOutboundForMethod grantee-aware rules (GHSA-9vg8 part A)', () => {
  it('is a no-op for grantee methods when the allowlist is off', () => {
    expect(checkOutboundForMethod('drive.permissions.create', { type: 'anyone', role: 'reader' }, 'a', {})).toBeNull();
    expect(checkOutboundForMethod('calendar.acl.insert', { scope: { type: 'default' } }, 'a', {})).toBeNull();
  });

  const BLOCKED = 'blocked';
  const OK = 'ok';
  const cases: Array<[string, unknown, 'blocked' | 'ok']> = [
    // --- reporter's exact reproduction cases ---
    ['drive.permissions.create', { type: 'anyone', role: 'reader' }, BLOCKED],
    ['drive.permissions.create', { type: 'domain', domain: 'evil.example', role: 'reader' }, BLOCKED],
    ['gmail.users.settings.delegates.create', { delegateEmail: 'x@evil.example' }, BLOCKED],
    ['calendar.acl.insert', { role: 'reader', scope: { type: 'user', value: 'x@evil.example' } }, BLOCKED],
    // --- Drive permissions: the rest of the type matrix ---
    ['drive.permissions.create', { type: 'domain', domain: 'corp.com', role: 'reader' }, OK],
    ['drive.permissions.create', { type: 'user', emailAddress: 'a@corp.com', role: 'reader' }, OK],
    ['drive.permissions.create', { type: 'user', emailAddress: 'bad@evil.io', role: 'reader' }, BLOCKED],
    ['drive.permissions.update', { type: 'anyone', role: 'writer' }, BLOCKED],
    ['drive.permissions.create', { role: 'reader' }, BLOCKED], // no `type` at all: unknown shape, fail closed
    // --- Gmail settings: forwarding / send-as / filters ---
    ['gmail.users.settings.forwardingAddresses.create', { forwardingEmail: 'x@evil.example' }, BLOCKED],
    ['gmail.users.settings.forwardingAddresses.create', { forwardingEmail: 'a@corp.com' }, OK],
    ['gmail.users.settings.sendAs.create', { sendAsEmail: 'x@evil.example' }, BLOCKED],
    ['gmail.users.settings.sendAs.create', { sendAsEmail: 'boss@partner.io' }, OK],
    ['gmail.users.settings.filters.create', { action: { forward: 'x@evil.example' } }, BLOCKED],
    ['gmail.users.settings.filters.create', { action: { addLabelIds: ['INBOX'] } }, OK], // no forward: ungated label/archive filter
    ['gmail.users.settings.filters.create', { criteria: { from: 'x@evil.example' } }, OK], // inbound match condition, not a destination
    ['gmail.users.settings.filters.create', {}, OK],
    // --- Calendar ACL: user/group/domain/default ---
    ['calendar.acl.insert', { role: 'reader', scope: { type: 'domain', value: 'evil.example' } }, BLOCKED],
    ['calendar.acl.insert', { role: 'reader', scope: { type: 'domain', value: 'corp.com' } }, OK],
    ['calendar.acl.insert', { role: 'reader', scope: { type: 'default' } }, BLOCKED], // public, same as Drive "anyone"
    ['calendar.acl.update', { scope: { type: 'group', value: 'bad@evil.io' } }, BLOCKED],
    ['calendar.acl.patch', { scope: { type: 'group', value: 'a@corp.com' } }, OK],
    ['calendar.acl.patch', {}, BLOCKED], // missing scope entirely: unknown shape, fail closed
    ['calendar.acl.insert', { scope: { type: 'roomResource' } }, BLOCKED], // unrecognised scope type: fail closed
  ];

  it.each(cases)('%s %j -> %s', (methodId, body, expected) => {
    const r = checkOutboundForMethod(methodId, body, 'a', ENV);
    if (expected === 'blocked') {
      expect(r).not.toBeNull();
      expect(JSON.parse(r!.content[0].text).error).toBe('recipient_not_allowed');
    } else {
      expect(r).toBeNull();
    }
  });
});

// M1: a write to ANY method whose resource segment looks grantee-shaped
// (acl, permissions, members, memberships, delegates, forwardingAddresses,
// sendAs, invitations, accessBindings, students, teachers) fails closed
// while the allowlist is active, unless a specific shape rule exists,
// not just the 9 ids the previous version of this check happened to name.
describe('checkOutboundForMethod: fail closed on grantee-pattern writes with no rule (M1)', () => {
  const EXPLICIT_RULE_METHODS = new Set([
    'drive.permissions.create',
    'drive.permissions.update',
    'gmail.users.settings.delegates.create',
    'gmail.users.settings.forwardingAddresses.create',
    'gmail.users.settings.sendAs.create',
    'gmail.users.settings.filters.create',
    'calendar.acl.insert',
    'calendar.acl.update',
    'calendar.acl.patch',
  ]);

  // LOW (item 5): these match the grantee-pattern but are harmless, so an
  // EMPTY body (what this sweep probes with) is now correctly allowed,
  // not fail-closed; gmail.users.settings.sendAs.patch with a real
  // identity-changing field is still covered separately below.
  const ALWAYS_ALLOWED_EMPTY_BODY = new Set([
    'gmail.users.settings.sendAs.patch',
    'gmail.users.settings.sendAs.update',
    'people.contactGroups.members.modify',
  ]);

  // The reviewer's named probe cases: each previously passed through the
  // generic emailAddress/email key walk untouched (none of these fields are
  // named "email"/"emailAddress"), so GOOGLE_OUTBOUND_ALLOWLIST gated nothing.
  const probes: Array<[string, unknown]> = [
    ['chat.spaces.members.create', { member: { name: 'users/x@evil.com' } }],
    ['cloudidentity.groups.memberships.create', { preferredMemberKey: { id: 'x@evil.example' } }],
    ['classroom.invitations.create', { userId: 'x@evil.example', role: 'STUDENT' }],
    // illustrative id: accessBindings is not in this build's generated surface
    // (older GA4 Admin Discovery snapshot), but the pattern match is on the
    // method id's own resource segment, not on whether a tool exists for it.
    ['analyticsadmin.properties.accessBindings.create', { user: 'x@evil.example' }],
    ['gmail.users.settings.sendAs.patch', { replyToAddress: 'x@evil.example' }],
    ['gmail.users.settings.sendAs.update', { replyToAddress: 'x@evil.example' }],
  ];

  it.each(probes)('%s now fails closed (was previously allowed through unexamined)', (methodId, body) => {
    const r = checkOutboundForMethod(methodId, body, 'a', ENV, { httpMethod: 'POST' });
    expect(r).not.toBeNull();
    expect(JSON.parse(r!.content[0].text).error).toBe('recipient_not_allowed');
  });

  // A read on the same kind of resource is never fail-closed: only a write
  // can grant anything, and reads need to keep working with the allowlist on.
  it('a read on a grantee-pattern resource is not gated', () => {
    expect(checkOutboundForMethod('calendar.acl.list', {}, 'a', ENV, { httpMethod: 'GET' })).toBeNull();
    expect(checkOutboundForMethod('gmail.users.settings.delegates.list', {}, 'a', ENV, { httpMethod: 'GET' })).toBeNull();
  });

  // Table sweep over every generated method id whose resource segment
  // matches the pattern: each one without its own shape rule must fail
  // closed as a write and pass through untouched as a read.
  const GRANTEE_SEGMENTS = new Set([
    'acl', 'permissions', 'members', 'memberships', 'delegates',
    'forwardingAddresses', 'sendAs', 'invitations', 'accessBindings',
    'students', 'teachers',
  ]);
  const patternMatchedGenerated = Object.entries(GENERATED_METHOD_TOOLS).filter(
    ([id]) => id.split('.').some((segment) => GRANTEE_SEGMENTS.has(segment)),
  );

  it('sanity: the generated surface has more than a handful of grantee-pattern methods to sweep', () => {
    expect(patternMatchedGenerated.length).toBeGreaterThan(20);
  });

  it.each(patternMatchedGenerated)('generated %s (tool %s)', (methodId, toolName) => {
    if (EXPLICIT_RULE_METHODS.has(methodId)) return; // has its own shape rule; covered above
    if (inferCud(toolName) === 'read') {
      expect(checkOutboundForMethod(methodId, {}, 'a', ENV, { httpMethod: 'GET' }), methodId).toBeNull();
    } else if (ALWAYS_ALLOWED_EMPTY_BODY.has(methodId)) {
      expect(checkOutboundForMethod(methodId, {}, 'a', ENV, { httpMethod: 'POST' }), methodId).toBeNull();
    } else {
      const r = checkOutboundForMethod(methodId, {}, 'a', ENV, { httpMethod: 'POST' });
      expect(r, methodId).not.toBeNull();
      expect(JSON.parse(r!.content[0].text).error, methodId).toBe('recipient_not_allowed');
    }
  });
});

// MEDIUM (item 3): the seven M1 cases the prior fail-closed sweep still
// missed, because each has its own specific, understood body shape that
// the generic pattern-match/fail-closed fallback never reaches.
describe('checkOutboundForMethod: M1 per-method rules (item 3)', () => {
  it('classroom guardian invitations: invitedEmailAddress is gated', () => {
    const blocked = checkOutboundForMethod(
      'classroom.userProfiles.guardianInvitations.create',
      { invitedEmailAddress: 'evil@evil.example' },
      'a', ENV, { httpMethod: 'POST' },
    );
    expect(blocked).not.toBeNull();
    expect(JSON.parse(blocked!.content[0].text).error).toBe('recipient_not_allowed');

    const allowed = checkOutboundForMethod(
      'classroom.userProfiles.guardianInvitations.create',
      { invitedEmailAddress: 'a@corp.com' },
      'a', ENV, { httpMethod: 'POST' },
    );
    expect(allowed).toBeNull();
  });

  it('chat.spaces.setup: an unlisted memberships[].member.name users/<email> is gated', () => {
    const blocked = checkOutboundForMethod(
      'chat.spaces.setup',
      { space: { spaceType: 'SPACE' }, memberships: [{ member: { name: 'users/evil@evil.example', type: 'HUMAN' } }] },
      'a', ENV, { httpMethod: 'POST' },
    );
    expect(blocked).not.toBeNull();
    expect(JSON.parse(blocked!.content[0].text).error).toBe('recipient_not_allowed');

    const allowed = checkOutboundForMethod(
      'chat.spaces.setup',
      { space: { spaceType: 'SPACE' }, memberships: [{ member: { name: 'users/a@corp.com', type: 'HUMAN' } }] },
      'a', ENV, { httpMethod: 'POST' },
    );
    expect(allowed).toBeNull();
  });

  // MEDIUM (round 4, M1): a membership whose member is NOT users/<email>
  // (a numeric Chat user id, the common real-world form) or that uses
  // groupMember instead of member counted as zero grantees, not as an
  // unrecognised shape, letting it through unexamined.
  it('chat.spaces.setup: a numeric users/<id> membership or a groupMember is an unrecognised shape, not zero grantees', () => {
    const numericId = checkOutboundForMethod(
      'chat.spaces.setup',
      { space: { spaceType: 'SPACE' }, memberships: [{ member: { name: 'users/112233445566778899', type: 'HUMAN' } }] },
      'a', ENV, { httpMethod: 'POST' },
    );
    expect(numericId).not.toBeNull();
    expect(JSON.parse(numericId!.content[0].text).error).toBe('recipient_not_allowed');

    const groupMember = checkOutboundForMethod(
      'chat.spaces.setup',
      { space: { spaceType: 'SPACE' }, memberships: [{ groupMember: { name: 'groups/abc' } }] },
      'a', ENV, { httpMethod: 'POST' },
    );
    expect(groupMember).not.toBeNull();
    expect(JSON.parse(groupMember!.content[0].text).error).toBe('recipient_not_allowed');
  });

  it('directory.users.patch/insert/update: an unlisted recoveryEmail is gated; absence is not', () => {
    for (const methodId of ['directory.users.patch', 'directory.users.insert', 'directory.users.update']) {
      const blocked = checkOutboundForMethod(methodId, { recoveryEmail: 'evil@evil.example' }, 'a', ENV, { httpMethod: 'PATCH' });
      expect(blocked, methodId).not.toBeNull();
      expect(JSON.parse(blocked!.content[0].text).error, methodId).toBe('recipient_not_allowed');

      // Most admin updates never touch recoveryEmail; that must stay allowed.
      const untouched = checkOutboundForMethod(methodId, { name: { givenName: 'x' } }, 'a', ENV, { httpMethod: 'PATCH' });
      expect(untouched, methodId).toBeNull();
    }
  });

  it('drive.revisions.update: publishing is refused outright; a non-publishing update is not', () => {
    const published = checkOutboundForMethod('drive.revisions.update', { published: true }, 'a', ENV, { httpMethod: 'PATCH' });
    expect(published).not.toBeNull();
    expect(JSON.parse(published!.content[0].text).error).toBe('recipient_not_allowed');

    const outsideDomain = checkOutboundForMethod('drive.revisions.update', { publishedOutsideDomain: true }, 'a', ENV, { httpMethod: 'PATCH' });
    expect(outsideDomain).not.toBeNull();

    const pinOnly = checkOutboundForMethod('drive.revisions.update', { keepForever: true }, 'a', ENV, { httpMethod: 'PATCH' });
    expect(pinOnly).toBeNull();
  });

  it('gmail.users.settings.updateVacation: an unrestricted auto-reply is refused outright; a restricted one is not', () => {
    const unrestricted = checkOutboundForMethod('gmail.users.settings.updateVacation', { enableAutoReply: true }, 'a', ENV, { httpMethod: 'PUT' });
    expect(unrestricted).not.toBeNull();
    expect(JSON.parse(unrestricted!.content[0].text).error).toBe('recipient_not_allowed');

    const restricted = checkOutboundForMethod(
      'gmail.users.settings.updateVacation', { enableAutoReply: true, restrictToDomain: true }, 'a', ENV, { httpMethod: 'PUT' },
    );
    expect(restricted).toBeNull();

    const disabling = checkOutboundForMethod('gmail.users.settings.updateVacation', { enableAutoReply: false }, 'a', ENV, { httpMethod: 'PUT' });
    expect(disabling).toBeNull();
  });

  it('drive.accessproposals.resolve: ACCEPT fails closed on body alone (the requester is not in this call\'s body); DENY is unaffected', () => {
    // Even a body that LOOKS safe (an allowlisted-sounding role, nothing
    // resembling an email) must still fail closed: the real recipient is a
    // property of the proposal server-side, never of this call's own body.
    const accept = checkOutboundForMethod('drive.accessproposals.resolve', { action: 'ACCEPT', role: ['writer'] }, 'a', ENV, { httpMethod: 'POST' });
    expect(accept).not.toBeNull();
    expect(JSON.parse(accept!.content[0].text).error).toBe('recipient_not_allowed');

    const deny = checkOutboundForMethod('drive.accessproposals.resolve', { action: 'DENY' }, 'a', ENV, { httpMethod: 'POST' });
    expect(deny).toBeNull();
  });

  // MEDIUM (round 4, M2): the old check whitelisted "anything that is not
  // the exact string ACCEPT" as harmless, so a non-string, a differently
  // cased string, or any other unrecognised action value passed
  // unexamined. Only a literal "DENY" may be treated as harmless now.
  it('drive.accessproposals.resolve: a non-"DENY" action (wrong type, wrong case, anything else) still fails closed', () => {
    for (const action of [1, 'accept', 'Accept', 'CANCEL', {}]) {
      const r = checkOutboundForMethod('drive.accessproposals.resolve', { action, role: ['writer'] }, 'a', ENV, { httpMethod: 'POST' });
      expect(r, JSON.stringify(action)).not.toBeNull();
      expect(JSON.parse(r!.content[0].text).error, JSON.stringify(action)).toBe('recipient_not_allowed');
    }
  });

  it('drive.permissions.update: fails closed regardless of the body, even one claiming an allowlisted grantee (the real grantee is the permissionId path param, not the body)', () => {
    const r = checkOutboundForMethod(
      'drive.permissions.update',
      { role: 'writer', type: 'user', emailAddress: 'a@corp.com' },
      'a', ENV, { httpMethod: 'PATCH', pathParams: { permissionId: 'EXTERNAL_PERM_ID' } },
    );
    expect(r).not.toBeNull();
    expect(JSON.parse(r!.content[0].text).error).toBe('recipient_not_allowed');
  });

  // MEDIUM (round 4, M4): Google's JSON parser accepts a body keyed by the
  // proto field's snake_case name as readily as its camelCase JSON name,
  // and coerces a string onto a bool field. Every rule above read only
  // the literal camelCase key and compared against literal `true`, so the
  // exact same dangerous value spelled either of those other ways passed
  // unexamined.
  it('snake_case body keys are recognised exactly like their camelCase form', () => {
    const cases: Array<[string, unknown, string]> = [
      ['gmail.users.settings.updateVacation', { enable_auto_reply: true }, 'PUT'],
      ['drive.revisions.update', { published_outside_domain: true }, 'PATCH'],
      ['directory.users.update', { recovery_email: 'evil@evil.example' }, 'PUT'],
      ['drive.permissions.create', { type: 'user', role: 'writer', email_address: 'evil@evil.example' }, 'POST'],
      ['classroom.userProfiles.guardianInvitations.create', { invited_email_address: 'evil@evil.example' }, 'POST'],
      ['gmail.users.settings.updateAutoForwarding', { enabled: true, email_address: 'evil@evil.example' }, 'PUT'],
    ];
    for (const [methodId, body, httpMethod] of cases) {
      const r = checkOutboundForMethod(methodId, body, 'a', ENV, { httpMethod });
      expect(r, `${methodId}: ${JSON.stringify(body)}`).not.toBeNull();
      expect(JSON.parse(r!.content[0].text).error, methodId).toBe('recipient_not_allowed');
    }
  });

  it('a boolean gate treats a string "true" the same as the literal true, and "false" the same as absent', () => {
    const trueAsString = checkOutboundForMethod('drive.revisions.update', { published: 'true' }, 'a', ENV, { httpMethod: 'PATCH' });
    expect(trueAsString).not.toBeNull();

    const falseAsString = checkOutboundForMethod('drive.revisions.update', { published: 'false' }, 'a', ENV, { httpMethod: 'PATCH' });
    expect(falseAsString).toBeNull();

    const vacationStringTrue = checkOutboundForMethod('gmail.users.settings.updateVacation', { enableAutoReply: 'true' }, 'a', ENV, { httpMethod: 'PUT' });
    expect(vacationStringTrue).not.toBeNull();
  });

  // Normalisation must not accidentally defeat item 5's harmless-sendAs-patch
  // allowance: display_name is as harmless as displayName.
  it('a sendAs patch touching only signature/display_name (snake_case) is still allowed', () => {
    const r = checkOutboundForMethod('gmail.users.settings.sendAs.patch', { signature: 'x', display_name: 'y' }, 'a', ENV, { httpMethod: 'PATCH' });
    expect(r).toBeNull();
  });

  // MEDIUM (round 5, item 1): restrictToContacts/restrictToDomain were
  // read with the same lenient isTruthyGate as the enabling flag, so a
  // value Google likely parses as false ("0", "no", "", 0, [false]) was
  // misread as "the restriction is on" and let the call through.
  it('restrictToContacts/restrictToDomain only count as restricting on a strict true, not a lenient-truthy value', () => {
    const notActuallyRestricting = [0, '0', 'no', '', [false], 'False' /* case-insensitive false is still false */];
    for (const v of notActuallyRestricting) {
      const r = checkOutboundForMethod('gmail.users.settings.updateVacation', { enableAutoReply: true, restrictToContacts: v }, 'a', ENV, { httpMethod: 'PUT' });
      expect(r, `restrictToContacts: ${JSON.stringify(v)}`).not.toBeNull();
      expect(JSON.parse(r!.content[0].text).error, JSON.stringify(v)).toBe('recipient_not_allowed');
    }
    const domainArrayFalse = checkOutboundForMethod(
      'gmail.users.settings.updateVacation', { enableAutoReply: true, restrictToDomain: [false] }, 'a', ENV, { httpMethod: 'PUT' },
    );
    expect(domainArrayFalse).not.toBeNull();
    // A strict true, or a string that trims/lowercases to "true", still restricts.
    expect(checkOutboundForMethod('gmail.users.settings.updateVacation', { enableAutoReply: true, restrictToContacts: true }, 'a', ENV, { httpMethod: 'PUT' })).toBeNull();
    expect(checkOutboundForMethod('gmail.users.settings.updateVacation', { enableAutoReply: true, restrictToContacts: ' TRUE ' }, 'a', ENV, { httpMethod: 'PUT' })).toBeNull();
  });

  // LOW (round 5, item 2): two source keys that normalise to the same
  // name (enable_auto_reply and enableAutoReply) is ambiguous, not a
  // "last one wins" resolution; whichever value iteration order happens
  // to apply last is not something any rule should trust.
  it('two differently-spelled source keys normalising to the same key are refused as an unrecognised shape', () => {
    const cases: Array<[string, unknown, string]> = [
      ['gmail.users.settings.updateVacation', { enable_auto_reply: true, enableAutoReply: false }, 'PUT'],
      ['gmail.users.settings.updateVacation', { enableAutoReply: false, enable_auto_reply: true }, 'PUT'],
      ['gmail.users.settings.updateVacation', { enableAutoReply: true, restrict_to_contacts: true, restrictToContacts: false }, 'PUT'],
      ['drive.revisions.update', { published_outside_domain: 'TRUE', publishedOutsideDomain: false }, 'PATCH'],
    ];
    for (const [methodId, body, httpMethod] of cases) {
      const r = checkOutboundForMethod(methodId, body, 'a', ENV, { httpMethod });
      expect(r, `${methodId}: ${JSON.stringify(body)}`).not.toBeNull();
      expect(JSON.parse(r!.content[0].text).error, methodId).toBe('recipient_not_allowed');
    }
    // A single spelling, even an unusual one, is not ambiguous.
    expect(checkOutboundForMethod('gmail.users.settings.updateVacation', { enableAutoReply: false }, 'a', ENV, { httpMethod: 'PUT' })).toBeNull();
  });

  it('normalising a body containing a literal "__proto__" key does not pollute the object used for the checks', () => {
    const body = JSON.parse('{"type":"user","__proto__":{"emailAddress":"ok@corp.com"},"email_address":"evil@evil.example"}');
    const r = checkOutboundForMethod('drive.permissions.create', body, 'a', ENV, { httpMethod: 'POST' });
    expect(r).not.toBeNull(); // the real (normalised) emailAddress is evil@evil.example, not allowlisted
    expect(JSON.parse(r!.content[0].text).error).toBe('recipient_not_allowed');
  });

  // LOW (round 5, item 3): memberships present but not an array (a
  // number-keyed object, a bare string) hit Array.isArray's false branch
  // and were read as "no memberships", not as an unrecognised shape.
  it('chat.spaces.setup: memberships present but not an array is refused, not treated as empty', () => {
    for (const memberships of [{ 0: { member: { name: 'users/112233' } } }, { member: { name: 'users/112233' } }, 'users/1']) {
      const r = checkOutboundForMethod('chat.spaces.setup', { space: { spaceType: 'SPACE' }, memberships }, 'a', ENV, { httpMethod: 'POST' });
      expect(r, JSON.stringify(memberships)).not.toBeNull();
      expect(JSON.parse(r!.content[0].text).error, JSON.stringify(memberships)).toBe('recipient_not_allowed');
    }
    // Absent, or a real empty array, is still a legitimate "no memberships yet".
    expect(checkOutboundForMethod('chat.spaces.setup', { space: { spaceType: 'SPACE' } }, 'a', ENV, { httpMethod: 'POST' })).toBeNull();
    expect(checkOutboundForMethod('chat.spaces.setup', { space: { spaceType: 'SPACE' }, memberships: [] }, 'a', ENV, { httpMethod: 'POST' })).toBeNull();
  });
});

// MEDIUM (item 3), curated-twin coverage: drive_permission_update and
// drive_access_proposal_resolve each look the real grantee up themselves
// (permissions.get / accessproposals.get) rather than trust their own
// call's body/args, since neither carries the grantee at all. These run
// through the actual tool handler, not checkOutboundForMethod, to prove
// the curated path is wired, not just the escape hatch.
describe('curated twins look the real grantee up instead of trusting their own args (item 3)', () => {
  const prior = process.env.GOOGLE_OUTBOUND_ALLOWLIST;
  beforeEach(() => {
    process.env.GOOGLE_OUTBOUND_ALLOWLIST = 'a@corp.com,@corp.com';
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.GOOGLE_OUTBOUND_ALLOWLIST;
    else process.env.GOOGLE_OUTBOUND_ALLOWLIST = prior;
  });

  it('drive_permission_update refuses when the permission being patched belongs to an unlisted grantee', async () => {
    const h = toolHarness({
      requestImpl: async (req: GoogleRequest) => {
        if ((req.method ?? 'GET').toUpperCase() === 'GET') {
          return { data: { type: 'user', emailAddress: 'evil@evil.example' }, headers: new Headers() };
        }
        throw new Error('permissions.update should never be reached');
      },
    });
    const res = await h.call('drive_permission_update', { account: 'test', fileId: 'f1', permissionId: 'EXTERNAL_PERM_ID', role: 'writer' });
    expect(res.isError).toBe(true);
    expect(parseResult(res).error).toBe('recipient_not_allowed');
  });

  it('drive_permission_update proceeds when the real grantee (looked up) is allowlisted', async () => {
    const h = toolHarness({
      requestImpl: async (req: GoogleRequest) => {
        if ((req.method ?? 'GET').toUpperCase() === 'GET') {
          return { data: { type: 'user', emailAddress: 'a@corp.com' }, headers: new Headers() };
        }
        return { data: { id: 'EXTERNAL_PERM_ID', role: 'writer' }, headers: new Headers() };
      },
    });
    const res = await h.call('drive_permission_update', { account: 'test', fileId: 'f1', permissionId: 'EXTERNAL_PERM_ID', role: 'writer' });
    expect(res.isError).toBeFalsy();
  });

  it('drive_access_proposal_resolve ACCEPT refuses when the proposal\'s recipient is unlisted', async () => {
    const h = toolHarness({
      requestImpl: async (req: GoogleRequest) => {
        if ((req.method ?? 'GET').toUpperCase() === 'GET') {
          return { data: { recipientEmailAddress: 'evil@evil.example' }, headers: new Headers() };
        }
        throw new Error('accessproposals.resolve should never be reached');
      },
    });
    const res = await h.call('drive_access_proposal_resolve', { account: 'test', fileId: 'f1', proposalId: 'p1', action: 'ACCEPT', role: ['writer'] });
    expect(res.isError).toBe(true);
    expect(parseResult(res).error).toBe('recipient_not_allowed');
  });

  it('drive_access_proposal_resolve DENY is never gated (it grants nothing, so no lookup is even made)', async () => {
    const h = toolHarness({
      requestImpl: async (req: GoogleRequest) => {
        if ((req.method ?? 'GET').toUpperCase() === 'GET') throw new Error('DENY must not look the proposal up at all');
        return { data: { resolved: true }, headers: new Headers() };
      },
    });
    const res = await h.call('drive_access_proposal_resolve', { account: 'test', fileId: 'f1', proposalId: 'p1', action: 'DENY' });
    expect(res.isError).toBeFalsy();
  });

  // LOW (round 4 test hardening): item 3 covered gmail_set_vacation and
  // drive_revision_update's own refusal logic via checkOutboundForMethod/
  // dangerousDefaultRefusal directly; these go through the real curated
  // tool handler instead, the same way the drive_permission_update and
  // drive_access_proposal_resolve cases above do.
  it('gmail_set_vacation refuses enabling an unrestricted auto-reply', async () => {
    const h = toolHarness({ respond: () => ({}) });
    const res = await h.call('gmail_set_vacation', { account: 'test', enableAutoReply: true, responseBodyPlainText: 'hi' });
    expect(res.isError).toBe(true);
    expect(parseResult(res).error).toBe('recipient_not_allowed');
    expect(h.requests()).toHaveLength(0); // refused before the API call, not after
  });

  it('gmail_set_vacation still succeeds when restricted to contacts or domain', async () => {
    const h = toolHarness({ respond: () => ({ enableAutoReply: true, restrictToDomain: true }) });
    const res = await h.call('gmail_set_vacation', { account: 'test', enableAutoReply: true, restrictToDomain: true });
    expect(res.isError).toBeFalsy();
  });

  it('drive_revision_update refuses publishing a revision', async () => {
    const h = toolHarness({ respond: () => ({}) });
    const res = await h.call('drive_revision_update', { account: 'test', fileId: 'f1', revisionId: 'r1', published: true });
    expect(res.isError).toBe(true);
    expect(parseResult(res).error).toBe('recipient_not_allowed');
    expect(h.requests()).toHaveLength(0);
  });

  it('drive_revision_update still succeeds for a non-publishing change (keepForever)', async () => {
    const h = toolHarness({ respond: () => ({ id: 'r1', keepForever: true }) });
    const res = await h.call('drive_revision_update', { account: 'test', fileId: 'f1', revisionId: 'r1', keepForever: true });
    expect(res.isError).toBeFalsy();
  });
});

// LOW (item 5): the grantee-pattern fail-closed fallback over-blocked
// removals and a couple of harmless writes, with a "body shape" error that
// did not even apply to a bodyless DELETE.
describe('checkOutboundForMethod: the grantee-pattern fallback does not over-block removals (item 5)', () => {
  const removals: Array<[string, unknown]> = [
    ['calendar.acl.delete', undefined],
    ['gmail.users.settings.delegates.delete', undefined],
    ['gmail.users.settings.forwardingAddresses.delete', undefined],
    ['gmail.users.settings.sendAs.delete', undefined],
    ['chat.spaces.members.delete', undefined],
  ];

  it.each(removals)('%s (a DELETE) is not fail-closed: revoking access is always safe', (methodId, body) => {
    expect(checkOutboundForMethod(methodId, body, 'a', ENV, { httpMethod: 'DELETE' }), methodId).toBeNull();
  });

  it('the same resource as a non-DELETE write is still fail-closed (DELETE is the exemption, not the resource)', () => {
    const r = checkOutboundForMethod('gmail.users.settings.delegates.create' /* has its own rule, but confirms POST isn't exempt */, {}, 'a', ENV, {
      httpMethod: 'POST',
    });
    expect(r).not.toBeNull();
  });

  it('a sendAs patch touching only signature/displayName is allowed; one touching replyToAddress is still refused', () => {
    expect(checkOutboundForMethod('gmail.users.settings.sendAs.patch', { signature: '<p>Thanks</p>' }, 'a', ENV, { httpMethod: 'PATCH' })).toBeNull();
    expect(
      checkOutboundForMethod('gmail.users.settings.sendAs.patch', { displayName: 'Jane Doe', signature: 'hi' }, 'a', ENV, { httpMethod: 'PATCH' }),
    ).toBeNull();
    const blocked = checkOutboundForMethod('gmail.users.settings.sendAs.patch', { replyToAddress: 'evil@evil.example' }, 'a', ENV, { httpMethod: 'PATCH' });
    expect(blocked).not.toBeNull();
    expect(JSON.parse(blocked!.content[0].text).error).toBe('recipient_not_allowed');
  });

  it('people.contactGroups.members.modify is allowed: it reorganizes the caller\'s own contacts, granting nothing to anyone new', () => {
    expect(
      checkOutboundForMethod('people.contactGroups.members.modify', { resourceNamesToAdd: ['people/c1'] }, 'a', ENV, { httpMethod: 'POST' }),
    ).toBeNull();
  });

  it('the error for an unexempted grantee-pattern write accurately describes a missing rule, not a body shape', () => {
    const r = checkOutboundForMethod('cloudidentity.groups.memberships.create', { preferredMemberKey: { id: 'x@evil.example' } }, 'a', ENV, {
      httpMethod: 'POST',
    });
    expect(r).not.toBeNull();
    expect(JSON.parse(r!.content[0].text).message).toContain('no specific rule yet');
  });
});

// LOW: the generic key walk and the method-aware rule both run for the 9
// GRANTEE_METHODS (docs say both are covered), not either/or.
describe('checkOutboundForMethod: generic walk AND method rule both apply', () => {
  it('a Drive permission body with an extra, differently-shaped email field is still caught by the generic walk', () => {
    // type:"user" is understood by the rule (and allowed, since emailAddress
    // is listed), but an unrelated nested email the rule does not look at
    // must still be caught by the generic key walk running alongside it.
    const r = checkOutboundForMethod(
      'drive.permissions.create',
      { type: 'user', emailAddress: 'a@corp.com', role: 'reader', notificationTarget: { email: 'bad@evil.io' } },
      'a',
      ENV,
    );
    expect(r).not.toBeNull();
    expect(JSON.parse(r!.content[0].text).error).toBe('recipient_not_allowed');
  });
});

// LOW: for calendar.acl update/patch, the grantee can be named only in the
// path (aclId, e.g. "user:x@evil.example"), independently of whatever the
// body's own `scope` says.
describe('checkOutboundForMethod: calendar.acl update/patch pathParams.ruleId', () => {
  // Bodies below are deliberately shaped to be ALLOWED on their own, so only
  // the ruleId-sourced grantee (unioned with the body's) can explain a block
  // otherwise a body-level fail-closed/deny would make these vacuous.
  it('a ruleId naming an unlisted user blocks the call even when the body names an allowed one', () => {
    const r = checkOutboundForMethod('calendar.acl.update', { scope: { type: 'user', value: 'a@corp.com' } }, 'a', ENV, {
      httpMethod: 'PATCH',
      pathParams: { ruleId: 'user:x@evil.example' },
    });
    expect(r).not.toBeNull();
    expect(JSON.parse(r!.content[0].text).error).toBe('recipient_not_allowed');
  });

  it('a ruleId naming a listed domain is allowed', () => {
    const r = checkOutboundForMethod('calendar.acl.patch', { scope: { type: 'domain', value: 'corp.com' } }, 'a', ENV, {
      httpMethod: 'PATCH',
      pathParams: { ruleId: 'domain:corp.com' },
    });
    expect(r).toBeNull();
  });

  it('ruleId "default" alone carries no grantee; an otherwise-allowed body still passes', () => {
    const r = checkOutboundForMethod('calendar.acl.update', { scope: { type: 'user', value: 'a@corp.com' } }, 'a', ENV, {
      httpMethod: 'PATCH',
      pathParams: { ruleId: 'default' },
    });
    expect(r).toBeNull();
  });

  it('calendar.acl.insert (no ruleId yet) is unaffected by pathParams', () => {
    const r = checkOutboundForMethod('calendar.acl.insert', { scope: { type: 'user', value: 'a@corp.com' } }, 'a', ENV, {
      httpMethod: 'POST',
      pathParams: {},
    });
    expect(r).toBeNull();
  });
});

// LOW: allows() must validate a SINGLE address, not a comma/semicolon-joined
// string that happens to end with an allowed @domain suffix.
describe('resolveOutboundAllowlist: allows() rejects multi-address smuggling', () => {
  it('rejects a comma-joined pair even when the second address is allowed', () => {
    const l = resolveOutboundAllowlist(ENV)!;
    expect(l.allows('evil@evil.io,a@corp.com')).toBe(false);
  });

  it('rejects a semicolon- or whitespace-joined pair', () => {
    const l = resolveOutboundAllowlist(ENV)!;
    expect(l.allows('evil@evil.io;a@corp.com')).toBe(false);
    expect(l.allows('evil@evil.io a@corp.com')).toBe(false);
  });

  it('rejects a string with more than one "@"', () => {
    const l = resolveOutboundAllowlist(ENV)!;
    expect(l.allows('a@corp.com@evil.io')).toBe(false);
  });

  it('still allows a genuine single address', () => {
    const l = resolveOutboundAllowlist(ENV)!;
    expect(l.allows('a@corp.com')).toBe(true);
  });
});

// LOW: a filter forward action that isn't a plain string is an unrecognised
// shape (fail closed), not silently treated as "no forward".
describe('checkOutboundForMethod: gmail filter action.forward must be a string', () => {
  it.each([
    ['a number', 1],
    ['an array', ['x@evil.example']],
    ['an object', { address: 'x@evil.example' }],
    ['an empty string', ''],
  ])('%s forward value fails closed', (_label, forward) => {
    const r = checkOutboundForMethod('gmail.users.settings.filters.create', { action: { forward } }, 'a', ENV);
    expect(r).not.toBeNull();
    expect(JSON.parse(r!.content[0].text).error).toBe('recipient_not_allowed');
  });

  it('a genuine string forward is still checked normally', () => {
    const blocked = checkOutboundForMethod('gmail.users.settings.filters.create', { action: { forward: 'x@evil.example' } }, 'a', ENV);
    expect(blocked).not.toBeNull();
    const allowed = checkOutboundForMethod('gmail.users.settings.filters.create', { action: { forward: 'a@corp.com' } }, 'a', ENV);
    expect(allowed).toBeNull();
  });
});
