import { describe, it, expect } from 'vitest';
import { redactor } from '../src/redactor.js';

describe('redactor', () => {
  it('returns primitives unchanged', () => {
    expect(redactor(null)).toBeNull();
    expect(redactor(undefined)).toBeUndefined();
    expect(redactor('hello')).toBe('hello');
    expect(redactor(42)).toBe(42);
    expect(redactor(true)).toBe(true);
  });

  it('redacts top-level secret keys (all variants)', () => {
    const input = {
      access_token: 'tok_abc123',
      refresh_token: 'ref_xyz789',
      client_secret: 'super_secret',
      private_key: '-----BEGIN RSA KEY-----',
      authorization: 'Bearer tok_abc123',
      enc_blob: 'encrypted_data_here',
      normal_field: 'keep me',
    };

    const result = redactor(input);

    expect(result.access_token).toBe('[REDACTED]');
    expect(result.refresh_token).toBe('[REDACTED]');
    expect(result.client_secret).toBe('[REDACTED]');
    expect(result.private_key).toBe('[REDACTED]');
    expect(result.authorization).toBe('[REDACTED]');
    expect(result.enc_blob).toBe('[REDACTED]');
    expect(result.normal_field).toBe('keep me');
  });

  it('is case-insensitive for secret keys', () => {
    const input = {
      Access_Token: 'tok_abc',
      REFRESH_TOKEN: 'ref_xyz',
      Authorization: 'Bearer tok',
      ACCESS_TOKEN: 'tok2',
    };

    const result = redactor(input);

    expect(result.Access_Token).toBe('[REDACTED]');
    expect(result.REFRESH_TOKEN).toBe('[REDACTED]');
    expect(result.Authorization).toBe('[REDACTED]');
    expect(result.ACCESS_TOKEN).toBe('[REDACTED]');
  });

  it('redacts secrets in nested objects', () => {
    const input = {
      outer: {
        access_token: 'nested_token',
        normal: 'outer_value',
        deeper: {
          refresh_token: 'deep_secret',
          client_secret: 'also_secret',
        },
      },
    };

    const result = redactor(input);

    expect(result.outer.access_token).toBe('[REDACTED]');
    expect(result.outer.normal).toBe('outer_value');
    expect(result.outer.deeper.refresh_token).toBe('[REDACTED]');
    expect(result.outer.deeper.client_secret).toBe('[REDACTED]');
  });

  it('redacts secrets inside arrays', () => {
    const input = {
      tokens: [
        { access_token: 'tok1' },
        { access_token: 'tok2' },
        'plain string',
        { refresh_token: 'ref1' },
      ],
    };

    const result = redactor(input);

    expect(result.tokens[0].access_token).toBe('[REDACTED]');
    expect(result.tokens[1].access_token).toBe('[REDACTED]');
    expect(result.tokens[2]).toBe('plain string');
    expect(result.tokens[3].refresh_token).toBe('[REDACTED]');
  });

  it('does not mutate the original object', () => {
    const original = { access_token: 'original_token', normal: 'keep' };
    redactor(original);
    expect(original.access_token).toBe('original_token');
    expect(original.normal).toBe('keep');
  });

  it('handles circular references without infinite loop', () => {
    const circular: Record<string, unknown> = { normal: 'value' };
    circular.self = circular;

    // Should not throw
    const result = redactor(circular);
    expect(result.normal).toBe('value');
    // self references the result object itself (memo registration before recursion)
    expect((result as Record<string, unknown>).self).toBe(result);
  });

  it('deduplicates shared objects — identical input reference = identical output reference', () => {
    const shared = { access_token: 'shared_secret', normal: 'keep' };
    const input = { items: [shared, shared] };

    const result = redactor(input);

    // Same original object → same redacted result in both array slots
    expect(result.items[0]).toBe(result.items[1]);
    expect(result.items[0].access_token).toBe('[REDACTED]');
    expect(result.items[0].normal).toBe('keep');
  });

  it('handles deeply nested structures', () => {
    let deep: Record<string, unknown> = { access_token: 'deep_secret' };
    for (let i = 0; i < 50; i++) {
      deep = { nested: deep };
    }

    const result = redactor(deep);
    let current: unknown = result;
    for (let i = 0; i < 50; i++) {
      current = (current as Record<string, unknown>).nested;
    }
    expect((current as Record<string, unknown>).access_token).toBe('[REDACTED]');
  });

  it('redacts only the specified keys, leaves others intact', () => {
    const input = {
      access_token: 'tok',
      email: 'user@example.com',
      user_id: 12345,
      enabled: true,
    };

    const result = redactor(input);

    expect(result.access_token).toBe('[REDACTED]');
    expect(result.email).toBe('user@example.com');
    expect(result.user_id).toBe(12345);
    expect(result.enabled).toBe(true);
  });
});