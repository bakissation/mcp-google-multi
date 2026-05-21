import { describe, it, expect } from 'vitest';
import { redact } from '../src/redactor.js';

describe('redact', () => {
  it('redacts top-level secret keys (snake_case)', () => {
    const out = redact({
      access_token: 'a', refresh_token: 'b', id_token: 'c', client_secret: 'd',
      private_key: 'e', authorization: 'Bearer x', auth_token: 't', api_key: 'k',
      password: 'p', enc_blob: 'z',
    });
    for (const v of Object.values(out)) expect(v).toBe('[REDACTED]');
  });

  it('redacts camelCase and capitalized variants', () => {
    const out = redact({
      accessToken: 'a', refreshToken: 'b', idToken: 'c', authToken: 'd',
      clientSecret: 'e', privateKey: 'f', apiKey: 'g', Authorization: 'h',
    });
    for (const v of Object.values(out)) expect(v).toBe('[REDACTED]');
  });

  it('redacts nested objects and arrays', () => {
    const out = redact({ a: { b: { access_token: 'x' } }, arr: [{ refresh_token: 'y' }] });
    expect(out.a.b.access_token).toBe('[REDACTED]');
    expect(out.arr[0].refresh_token).toBe('[REDACTED]');
  });

  it('does NOT over-redact non-secret Google fields', () => {
    const input = { pageToken: '1', nextPageToken: '2', token_type: 'Bearer', scope: 's', email: 'a@b.com', expiry_date: 123 };
    expect(redact(input)).toEqual(input);
  });

  it('handles circular references', () => {
    const o: Record<string, unknown> = { access_token: 'x' };
    o.self = o;
    const out = redact(o) as Record<string, unknown>;
    expect(out.access_token).toBe('[REDACTED]');
    expect(out.self).toBe(out);
  });

  it('collapses shared references to one redacted copy', () => {
    const shared = { refresh_token: 'x' };
    const out = redact({ a: shared, b: shared });
    expect(out.a).toBe(out.b);
    expect(out.a.refresh_token).toBe('[REDACTED]');
  });

  it('does not mutate the input', () => {
    const input = { access_token: 'secret', keep: 1 };
    redact(input);
    expect(input.access_token).toBe('secret');
  });

  it('passes through primitives', () => {
    expect(redact('hello')).toBe('hello');
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
  });

  it('redacts secret keys inside Error objects but keeps name + message', () => {
    const e = new Error('boom') as Error & { access_token?: string; config?: unknown };
    e.access_token = 'x';
    e.config = { headers: { Authorization: 'Bearer y' } };
    const out = redact(e) as Record<string, unknown>;
    expect(out.name).toBe('Error');
    expect(out.message).toBe('boom');
    expect(out.access_token).toBe('[REDACTED]');
    expect((out.config as { headers: { Authorization: string } }).headers.Authorization).toBe('[REDACTED]');
  });

  it('does not leak Buffer bytes', () => {
    const out = redact({ enc_blob: Buffer.from('x'), other: Buffer.from('y') });
    expect(out.enc_blob).toBe('[REDACTED]');
    expect(out.other).toBe('[Buffer]');
  });

  it('keeps Date values intact', () => {
    const d = new Date('2020-01-01T00:00:00Z');
    expect(redact({ when: d }).when).toBe(d);
  });
});
