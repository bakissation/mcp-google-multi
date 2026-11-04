import { describe, it, expect } from 'vitest';
import { denyReason, escapeHatchVerdict, isAllowed, writeDisabledResult, type Policy, type Profile } from '../src/write-control.js';
import type { Cud } from '../src/registry.js';

const policy = (over: Partial<Policy> = {}): Policy =>
  ({ profile: 'safe-writes', readOnly: false, allow: [], deny: [], ...over });

const TRASH = { name: 'gmail_trash', service: 'gmail', cud: 'delete' as const };
const DELETE = { name: 'drive_delete', service: 'drive', cud: 'delete' as const };
const SEND = { name: 'gmail_send', service: 'gmail', cud: 'create' as const };

const hintOf = (tool: typeof TRASH | typeof DELETE | typeof SEND, p: Policy) =>
  JSON.parse(writeDisabledResult(tool, p).content[0].text).hint as string;

describe('the hint never proposes the setting that just refused', () => {
  // A delete refused under safe-writes was once told to "Enable via
  // GOOGLE_PROFILE=safe-writes|full-writes"; following that changes nothing.
  it('does not offer the current profile back to the caller', () => {
    const h = hintOf(DELETE, policy({ profile: 'safe-writes' }));
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
    expect(hintOf(TRASH, policy({ profile: 'read-only' }))).toContain('"gmail:trash"');
  });

  // #312: drive_update's op IS its cud, so "drive:update" also matches
  // drive_move, drive_permission_update and the rest of the update class.
  // The tool: form is the one that singles it out.
  it('offers the exact-tool pattern for a tool named after its own class', () => {
    const UPDATE = { name: 'drive_update', service: 'drive', cud: 'update' as Cud };
    const h = hintOf(UPDATE as typeof TRASH, policy({ profile: 'read-only' }));
    expect(h).toContain('allow just this one with GOOGLE_WRITE_ALLOW="tool:drive_update"');
    expect(h).toContain('every update-class drive tool with GOOGLE_WRITE_ALLOW="drive:update"');
    const allow = policy({ profile: 'read-only', allow: ['tool:drive_update'] });
    expect(isAllowed(UPDATE, allow)).toBe(true);
    for (const sibling of ['drive_move', 'drive_permission_update']) {
      expect(isAllowed({ name: sibling, service: 'drive', cud: 'update' }, allow)).toBe(false);
      expect(isAllowed({ name: sibling, service: 'drive', cud: 'update' }, policy({ profile: 'read-only', allow: ['drive:update'] }))).toBe(true);
    }
  });

  it('tool: denies one tool and leaves its same-class siblings alone', () => {
    const deny = policy({ profile: 'full-writes', deny: ['tool:drive_update'] });
    expect(isAllowed({ name: 'drive_update', service: 'drive', cud: 'update' }, deny)).toBe(false);
    expect(denyReason({ name: 'drive_update', service: 'drive', cud: 'update' }, deny)).toEqual({ rule: 'deny_glob', pattern: 'tool:drive_update' });
    for (const sibling of ['drive_move', 'drive_permission_update', 'drive_untrash']) {
      expect(isAllowed({ name: sibling, service: 'drive', cud: 'update' }, deny)).toBe(true);
    }
  });

  it('tool: takes globs, and a service-prefixed pattern never matches the tool: namespace', () => {
    const deny = policy({ profile: 'full-writes', deny: ['tool:gmail_*'] });
    expect(isAllowed({ name: 'gmail_send', service: 'gmail', cud: 'create' }, deny)).toBe(false);
    expect(isAllowed({ name: 'drive_update', service: 'drive', cud: 'update' }, deny)).toBe(true);
    // "*:update" must not start matching because of the extra candidate.
    const star = policy({ profile: 'full-writes', deny: ['*:send'] });
    expect(isAllowed({ name: 'gmail_send', service: 'gmail', cud: 'create' }, star)).toBe(false);
    expect(isAllowed({ name: 'gmail_draft', service: 'gmail', cud: 'create' }, star)).toBe(true);
  });

  it('a "just this one" pattern permits no sibling of the same class', () => {
    const MOVE = { name: 'drive_move', service: 'drive', cud: 'update' as Cud };
    const h = hintOf(MOVE as typeof TRASH, policy({ profile: 'read-only' }));
    expect(h).toContain('allow just this one with GOOGLE_WRITE_ALLOW="drive:move"');
    for (const sibling of ['drive_update', 'drive_permission_update']) {
      expect(isAllowed({ name: sibling, service: 'drive', cud: 'update' }, policy({ profile: 'read-only', allow: ['drive:move'] }))).toBe(false);
    }
  });
});

describe('tool: deny on the escape hatch', () => {
  it('matches the raw method name, so one raw method can be blocked alone', () => {
    const p = policy({ profile: 'full-writes', deny: ['tool:drive_files_update'] });
    const base = { service: 'drive', cud: 'update' as Cud };
    expect(escapeHatchVerdict(['drive_files_update'], base, 'drive_files_update', p, false).decision).toBe('deny');
    expect(escapeHatchVerdict(['drive_files_copy'], base, 'drive_files_copy', p, false).decision).toBe('allow');
  });
});

describe('denyReason', () => {
  it('is undefined when the call is permitted', () => {
    expect(denyReason(SEND, policy({ profile: 'full-writes' }))).toBeUndefined();
    expect(denyReason({ name: 'gmail_search', service: 'gmail', cud: 'read' }, policy({ readOnly: true }))).toBeUndefined();
    // gmail_trash moves to Trash rather than deleting permanently, so
    // safe-writes permits it like any other non-privileged write.
    expect(denyReason(TRASH, policy({ profile: 'safe-writes' }))).toBeUndefined();
  });

  it('reports the profile when nothing more specific refused', () => {
    expect(denyReason(DELETE, policy({ profile: 'safe-writes' }))).toEqual({ rule: 'profile', profile: 'safe-writes' });
  });
});
