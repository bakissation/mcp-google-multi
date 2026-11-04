import { describe, it, expect } from 'vitest';
import { bumpFor, isBreaking, libcCount, parseLog, type Commit } from '../scripts/ci-guards.js';

const c = (subject: string, body = ''): Commit => ({ sha: 'abc12345', subject, body });

describe('isBreaking', () => {
  it('flags the bang and the footer, nothing else', () => {
    expect(isBreaking(c('feat!: drop node 20'))).toBe(true);
    expect(isBreaking(c('fix(core)!: rename export'))).toBe(true);
    expect(isBreaking(c('feat: x', 'details\n\nBREAKING CHANGE: gone'))).toBe(true);
    expect(isBreaking(c('feat: x', 'BREAKING-CHANGE: gone'))).toBe(true);
    expect(isBreaking(c('feat: add a thing'))).toBe(false);
    expect(isBreaking(c('fix: mention BREAKING CHANGE in prose', 'this is not a BREAKING CHANGE footer'))).toBe(false);
  });
});

describe('bumpFor', () => {
  it('picks the highest bump', () => {
    expect(bumpFor([c('chore: x'), c('docs: y')])).toBe('none');
    expect(bumpFor([c('fix: x'), c('chore: y')])).toBe('patch');
    expect(bumpFor([c('fix: x'), c('feat(calendar): y')])).toBe('minor');
    expect(bumpFor([c('feat: x'), c('fix!: y')])).toBe('major');
  });
});

describe('libcCount', () => {
  it('counts libc keys in a lock text', () => {
    const lock = JSON.stringify({ packages: { a: { libc: ['glibc'] }, b: { cpu: ['x64'] }, c: { libc: ['musl'] } } }, null, 2);
    expect(libcCount(lock)).toBe(2);
  });
});

describe('parseLog', () => {
  it('splits records with subject and body', () => {
    const raw = 'aaa\x1ffeat: one\x1fbody one\x1e\nbbb\x1ffix: two\x1f\x1e';
    const out = parseLog(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ sha: 'aaa', subject: 'feat: one', body: 'body one' });
    expect(out[1]?.subject).toBe('fix: two');
  });
});
