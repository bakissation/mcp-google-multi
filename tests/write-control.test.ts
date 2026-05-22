import { describe, it, expect } from 'vitest';
import { resolvePolicy, isAllowed, describePolicy, type Policy } from '../src/write-control.js';

const tool = (name: string, cud: 'read' | 'create' | 'update' | 'delete') => ({
  name,
  service: name.slice(0, name.indexOf('_')),
  cud,
});

describe('resolvePolicy', () => {
  it('defaults to read-only, no globs', () => {
    expect(resolvePolicy({})).toEqual({ profile: 'read-only', readOnly: false, allow: [], deny: [] });
  });
  it('parses profile, readOnly, and glob lists', () => {
    const p = resolvePolicy({
      GOOGLE_PROFILE: 'safe-writes',
      GOOGLE_READ_ONLY: 'true',
      GOOGLE_WRITE_ALLOW: 'calendar:*, sheets:update*',
      GOOGLE_WRITE_DENY: '*:delete*',
    });
    expect(p).toEqual({
      profile: 'safe-writes',
      readOnly: true,
      allow: ['calendar:*', 'sheets:update*'],
      deny: ['*:delete*'],
    });
  });
  it('falls back to read-only on an invalid profile', () => {
    expect(resolvePolicy({ GOOGLE_PROFILE: 'bogus' }).profile).toBe('read-only');
  });
});

describe('isAllowed', () => {
  const ro: Policy = { profile: 'read-only', readOnly: false, allow: [], deny: [] };
  const safe: Policy = { profile: 'safe-writes', readOnly: false, allow: [], deny: [] };
  const full: Policy = { profile: 'full-writes', readOnly: false, allow: [], deny: [] };

  it('reads always pass, even read-only', () => {
    expect(isAllowed(tool('gmail_search', 'read'), ro)).toBe(true);
  });
  it('read-only denies all CUD', () => {
    expect(isAllowed(tool('gmail_send', 'create'), ro)).toBe(false);
    expect(isAllowed(tool('drive_delete', 'delete'), ro)).toBe(false);
  });
  it('safe-writes allows create+update, denies delete', () => {
    expect(isAllowed(tool('gmail_send', 'create'), safe)).toBe(true);
    expect(isAllowed(tool('drive_update', 'update'), safe)).toBe(true);
    expect(isAllowed(tool('drive_delete', 'delete'), safe)).toBe(false);
  });
  it('full-writes allows everything', () => {
    expect(isAllowed(tool('drive_delete', 'delete'), full)).toBe(true);
  });
  it('GOOGLE_READ_ONLY beats any profile', () => {
    expect(isAllowed(tool('gmail_send', 'create'), { ...full, readOnly: true })).toBe(false);
  });
  it('deny glob wins over allow + profile', () => {
    const p: Policy = { profile: 'full-writes', readOnly: false, allow: ['drive:*'], deny: ['*:delete*'] };
    expect(isAllowed(tool('drive_delete', 'delete'), p)).toBe(false);
    expect(isAllowed(tool('drive_update', 'update'), p)).toBe(true);
  });
  it('allow glob opens a hole in a restrictive profile', () => {
    const p: Policy = { profile: 'read-only', readOnly: false, allow: ['calendar:*'], deny: [] };
    expect(isAllowed(tool('calendar_create_event', 'create'), p)).toBe(true);
    expect(isAllowed(tool('gmail_send', 'create'), p)).toBe(false);
  });
  it('allow matches by operation name (gmail:send)', () => {
    const p: Policy = { profile: 'read-only', readOnly: false, allow: ['gmail:send'], deny: [] };
    expect(isAllowed(tool('gmail_send', 'create'), p)).toBe(true);
  });
  it('precedence holds: readonly > deny > allow > profile', () => {
    expect(isAllowed(tool('gmail_send', 'create'), { profile: 'full-writes', readOnly: true, allow: ['*:*'], deny: [] })).toBe(false);
  });
});

describe('describePolicy', () => {
  it('renders a one-line summary', () => {
    expect(
      describePolicy({ profile: 'safe-writes', readOnly: false, allow: ['a:*'], deny: ['*:delete*'] }),
    ).toBe('profile=safe-writes readOnly=false allow=[a:*] deny=[*:delete*]');
  });
});
