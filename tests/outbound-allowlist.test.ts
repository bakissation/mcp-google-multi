import { describe, it, expect } from 'vitest';
import {
  checkOutbound,
  checkOutboundForMethod,
  collectBodyRecipients,
  outboundViolations,
  resolveOutboundAllowlist,
} from '../src/outbound-allowlist.js';
import { setHintProvider } from '../src/hint-provider.js';

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
