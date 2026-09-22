import { describe, it, expect } from 'vitest';
import {
  checkOutbound,
  checkOutboundForMethod,
  collectBodyRecipients,
  outboundViolations,
  resolveOutboundAllowlist,
} from '../src/outbound-allowlist.js';

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
