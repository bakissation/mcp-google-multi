import { describe, it, expect } from 'vitest';
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
    } else {
      const r = checkOutboundForMethod(methodId, {}, 'a', ENV, { httpMethod: 'POST' });
      expect(r, methodId).not.toBeNull();
      expect(JSON.parse(r!.content[0].text).error, methodId).toBe('recipient_not_allowed');
    }
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
