import { describe, it, expect } from 'vitest';
import { denyReason, isAllowed, writeDisabledResult, type Policy, type Profile } from '../src/write-control.js';
import type { Cud } from '../src/registry.js';

const policy = (over: Partial<Policy> = {}): Policy =>
  ({ profile: 'safe-writes', readOnly: false, allow: [], deny: [], ...over });

const TRASH = { name: 'gmail_trash', service: 'gmail', cud: 'delete' as const };
const SEND = { name: 'gmail_send', service: 'gmail', cud: 'create' as const };

const hintOf = (tool: typeof TRASH | typeof SEND, p: Policy) =>
  JSON.parse(writeDisabledResult(tool, p).content[0].text).hint as string;

describe('the hint never proposes the setting that just refused', () => {
  // The bug: a delete refused under safe-writes was told to "Enable via
  // GOOGLE_PROFILE=safe-writes|full-writes". Following that changes nothing.
  it('does not offer the current profile back to the caller', () => {
    const h = hintOf(TRASH, policy({ profile: 'safe-writes' }));
    expect(h).toContain('full-writes');
    expect(h).not.toContain('=safe-writes');
    expect(h).not.toContain('or safe-writes');
  });

  const PROFILES: Profile[] = ['read-only', 'safe-writes', 'full-writes'];
  const CUDS: Cud[] = ['create', 'update', 'delete'];

  it('holds for every profile and cud that can be refused', () => {
    for (const profile of PROFILES) {
      for (const cud of CUDS) {
        const tool = { name: `svc_op_${cud}`, service: 'svc', cud };
        const p = policy({ profile });
        if (isAllowed(tool, p)) continue;
        const h = hintOf(tool as typeof TRASH, p);
        expect(h, `${profile}/${cud}`).not.toMatch(new RegExp(`GOOGLE_PROFILE=[^ ."]*${profile}`));
      }
    }
  });
});

describe('the hint names the rule that actually decided', () => {
  it('read-only mode points at GOOGLE_READ_ONLY, not the profile', () => {
    const h = hintOf(SEND, policy({ profile: 'full-writes', readOnly: true }));
    expect(h).toContain('GOOGLE_READ_ONLY');
    // A profile change cannot lift readOnly, so offering one would be a lie.
    expect(h).not.toContain('GOOGLE_PROFILE=');
    expect(h).not.toContain('GOOGLE_WRITE_ALLOW');
  });

  it('a deny glob is quoted back, and allow is not offered as a way around it', () => {
    const h = hintOf(SEND, policy({ profile: 'full-writes', deny: ['gmail:send'] }));
    expect(h).toContain('"gmail:send"');
    expect(h).not.toContain('GOOGLE_WRITE_ALLOW');
  });

  it('deny beats allow, and the hint reflects that precedence', () => {
    const p = policy({ profile: 'full-writes', allow: ['gmail:*'], deny: ['gmail:send'] });
    expect(isAllowed(SEND, p)).toBe(false);
    expect(denyReason(SEND, p)).toEqual({ rule: 'deny_glob', pattern: 'gmail:send' });
  });
});

describe('the suggested allow pattern is one the matcher accepts', () => {
  // service:op / service:cud is the whole vocabulary; a tool name never matches.
  it('round-trips: applying the suggested pattern actually permits the call', () => {
    for (const tool of [TRASH, SEND]) {
      const p = policy({ profile: 'read-only' });
      const h = hintOf(tool, p);
      const suggested = h.match(/GOOGLE_WRITE_ALLOW="([^"]+)"/)?.[1];
      expect(suggested, `no pattern suggested for ${tool.name}`).toBeTruthy();
      expect(isAllowed(tool, policy({ profile: 'read-only', allow: [suggested!] }))).toBe(true);
    }
  });

  it('suggests the operation, not the blunt service wildcard', () => {
    expect(hintOf(TRASH, policy({ profile: 'safe-writes' }))).toContain('"gmail:trash"');
  });
});

describe('denyReason', () => {
  it('is undefined when the call is permitted', () => {
    expect(denyReason(SEND, policy({ profile: 'full-writes' }))).toBeUndefined();
    expect(denyReason({ name: 'gmail_search', service: 'gmail', cud: 'read' }, policy({ readOnly: true }))).toBeUndefined();
  });

  it('reports the profile when nothing more specific refused', () => {
    expect(denyReason(TRASH, policy({ profile: 'safe-writes' }))).toEqual({ rule: 'profile', profile: 'safe-writes' });
  });
});
