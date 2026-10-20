import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  checkOutbound,
  checkOutboundGrantee,
  driveGranteeFromAccessProposal,
  driveGranteeFromPermission,
  outboundViolations,
  resolveOutboundAllowlist,
} from '../src/outbound-allowlist.js';
import { setHintProvider } from '../src/hint-provider.js';
import { toolHarness, parseResult, type GoogleRequest } from './_tool-harness.js';

// ROUND 6: this file used to also cover checkOutboundForMethod and
// collectBodyRecipients, the content-based rules the escape hatch (raw
// google_api_call and every generated per-method tool) used to run on
// its own. That machinery is gone: a write through the escape hatch now
// either fails closed on an explicit deny, is allowed outright under
// full-writes with GOOGLE_OUTBOUND_ALLOWLIST unset, or asks a human via
// elicitation who sees the real body and decides (tests/_escape-hatch
// and tests/google-api.test.ts cover that path). What remains here is
// what still serves CURATED tools: the allowlist itself, the grantee
// lookup helpers drive_permission_update and drive_access_proposal_resolve
// use, and the curated tools that call into this file directly.

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

// allows() must validate a SINGLE address, not a comma/semicolon-joined
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

describe('driveGranteeFromPermission', () => {
  it('type anyone is public, with no addressable recipient', () => {
    expect(driveGranteeFromPermission({ type: 'anyone' })).toEqual({ emails: [], domains: [], public: true, understood: true });
  });

  it('type domain carries the lowercased @domain', () => {
    expect(driveGranteeFromPermission({ type: 'domain', domain: 'Corp.com' })).toEqual({
      emails: [], domains: ['@corp.com'], public: false, understood: true,
    });
  });

  it('type user or group carries the email address', () => {
    expect(driveGranteeFromPermission({ type: 'user', emailAddress: 'a@corp.com' })).toEqual({
      emails: ['a@corp.com'], domains: [], public: false, understood: true,
    });
    expect(driveGranteeFromPermission({ type: 'group', emailAddress: 'g@corp.com' })).toEqual({
      emails: ['g@corp.com'], domains: [], public: false, understood: true,
    });
  });

  it('a domain grant with no domain string, a user/group grant with no email, a missing type, or null all come back unrecognized', () => {
    const UNRECOGNIZED = { emails: [], domains: [], public: false, understood: false };
    expect(driveGranteeFromPermission({ type: 'domain' })).toEqual(UNRECOGNIZED);
    expect(driveGranteeFromPermission({ type: 'user' })).toEqual(UNRECOGNIZED);
    expect(driveGranteeFromPermission({})).toEqual(UNRECOGNIZED);
    expect(driveGranteeFromPermission(null)).toEqual(UNRECOGNIZED);
    expect(driveGranteeFromPermission(undefined)).toEqual(UNRECOGNIZED);
  });
});

describe('driveGranteeFromAccessProposal', () => {
  it('prefers recipientEmailAddress over requesterEmailAddress', () => {
    expect(driveGranteeFromAccessProposal({ recipientEmailAddress: 'r@corp.com', requesterEmailAddress: 'q@corp.com' })).toEqual({
      emails: ['r@corp.com'], domains: [], public: false, understood: true,
    });
  });

  it('falls back to requesterEmailAddress when recipientEmailAddress is absent', () => {
    expect(driveGranteeFromAccessProposal({ requesterEmailAddress: 'q@corp.com' })).toEqual({
      emails: ['q@corp.com'], domains: [], public: false, understood: true,
    });
  });

  it('neither field, or null, is unrecognized', () => {
    const UNRECOGNIZED = { emails: [], domains: [], public: false, understood: false };
    expect(driveGranteeFromAccessProposal({})).toEqual(UNRECOGNIZED);
    expect(driveGranteeFromAccessProposal(null)).toEqual(UNRECOGNIZED);
  });
});

describe('checkOutboundGrantee', () => {
  it('is a no-op when the allowlist is off', () => {
    expect(checkOutboundGrantee('x', { emails: ['anything@anywhere.io'], domains: [], public: false, understood: true }, 'a', {})).toBeNull();
  });

  it('an unrecognized shape fails closed with its own message, not the generic recipient_not_allowed wording', () => {
    const r = checkOutboundGrantee('drive_permission_update', { emails: [], domains: [], public: false, understood: false }, 'a', ENV)!;
    const j = JSON.parse(r.content[0].text);
    expect(j.error).toBe('recipient_not_allowed');
    expect(j.message).toContain('does not recognize');
  });

  it('public is always blocked while active, however it is spelled', () => {
    const r = checkOutboundGrantee('drive_permission_update', { emails: [], domains: [], public: true, understood: true }, 'a', ENV)!;
    expect(JSON.parse(r.content[0].text).error).toBe('recipient_not_allowed');
  });

  it('an unlisted domain is blocked; a listed one passes', () => {
    const blocked = checkOutboundGrantee('x', { emails: [], domains: ['@evil.example'], public: false, understood: true }, 'a', ENV);
    expect(blocked).not.toBeNull();
    const allowed = checkOutboundGrantee('x', { emails: [], domains: ['@corp.com'], public: false, understood: true }, 'a', ENV);
    expect(allowed).toBeNull();
  });

  it('delegates to checkOutbound for plain emails', () => {
    const blocked = checkOutboundGrantee('x', { emails: ['bad@evil.io'], domains: [], public: false, understood: true }, 'a', ENV);
    expect(blocked).not.toBeNull();
    const allowed = checkOutboundGrantee('x', { emails: ['a@corp.com'], domains: [], public: false, understood: true }, 'a', ENV);
    expect(allowed).toBeNull();
  });

  it('no emails and no domains and not public is allowed (nothing to check)', () => {
    expect(checkOutboundGrantee('x', { emails: [], domains: [], public: false, understood: true }, 'a', ENV)).toBeNull();
  });
});

// Curated-twin coverage: drive_permission_update and
// drive_access_proposal_resolve each look the real grantee up themselves
// (permissions.get / accessproposals.get) rather than trust their own
// call's body/args, since neither carries the grantee at all. These run
// through the actual tool handler, not the helpers directly, to prove the
// curated path is wired, not just the helpers it calls.
describe('curated twins look the real grantee up instead of trusting their own args', () => {
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
