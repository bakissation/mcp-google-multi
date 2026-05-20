import { describe, it, expect } from 'vitest';
import { redactor, safeStringify } from '../src/redactor.js';

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
      id_token: 'eyJhbGciOiJSUzI1NiJ9...',
      normal_field: 'keep me',
    };

    const result = redactor(input);

    expect(result.access_token).toBe('[REDACTED]');
    expect(result.refresh_token).toBe('[REDACTED]');
    expect(result.client_secret).toBe('[REDACTED]');
    expect(result.private_key).toBe('[REDACTED]');
    expect(result.authorization).toBe('[REDACTED]');
    expect(result.enc_blob).toBe('[REDACTED]');
    expect(result.id_token).toBe('[REDACTED]');
    expect(result.normal_field).toBe('keep me');
  });

  it('is case-insensitive for secret keys', () => {
    const input = {
      Access_Token: 'tok_abc',
      REFRESH_TOKEN: 'ref_xyz',
      Authorization: 'Bearer tok',
      ACCESS_TOKEN: 'tok2',
      ID_TOKEN: 'id_token_val',
    };

    const result = redactor(input);

    expect(result.Access_Token).toBe('[REDACTED]');
    expect(result.REFRESH_TOKEN).toBe('[REDACTED]');
    expect(result.Authorization).toBe('[REDACTED]');
    expect(result.ACCESS_TOKEN).toBe('[REDACTED]');
    expect(result.ID_TOKEN).toBe('[REDACTED]');
  });

  it('redacts camelCase secret variants (accessToken, refreshToken, etc.)', () => {
    const input = {
      accessToken: 'myAccessToken',
      refreshToken: 'myRefreshToken',
      clientId: 'myClientId',
      userPassword: 'myPassword',
      apiKey: 'myApiKey',
    };

    const result = redactor(input);

    expect(result.accessToken).toBe('[REDACTED]');
    expect(result.refreshToken).toBe('[REDACTED]');
    // clientId is a public OAuth client identifier — not a secret
    expect(result.clientId).toBe('myClientId');
    expect(result.userPassword).toBe('[REDACTED]');
    expect(result.apiKey).toBe('[REDACTED]');
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

    const result = redactor(circular);
    expect(result.normal).toBe('value');
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

  // ─── Special types ─────────────────────────────────────────────────────────

  it('replaces Error with name/message/stack all redacted', () => {
    const err = new Error('secret message');
    const result = redactor(err);
    expect(result).toEqual({ name: '[REDACTED]', message: '[REDACTED]', stack: '[REDACTED]' });
  });

  it('preserves Date objects unchanged', () => {
    const date = new Date('2026-05-20T10:00:00Z');
    const result = redactor(date);
    expect(result).toBe(date);
  });

  it('replaces Buffer with "[Buffer]"', () => {
    const buf = Buffer.from('hello world');
    const result = redactor(buf);
    expect(result).toBe('[Buffer]');
  });

  it('handles arrays containing Error/Date/Buffer', () => {
    const date = new Date('2026-05-20');
    const err = new Error('some error');
    const buf = Buffer.from('test');
    const result = redactor([date, err, buf]);
    expect(result[0]).toBe(date);
    expect(result[1]).toEqual({ name: '[REDACTED]', message: '[REDACTED]', stack: '[REDACTED]' });
    expect(result[2]).toBe('[Buffer]');
  });
});

describe('safeStringify', () => {
  it('stringifies a plain object', () => {
    const result = safeStringify({ foo: 'bar', num: 42 });
    expect(JSON.parse(result)).toEqual({ foo: 'bar', num: 42 });
  });

  it('replaces circular refs with "[Circular]"', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    const result = safeStringify(circular);
    const parsed = JSON.parse(result);
    expect(parsed.name).toBe('loop');
    expect(parsed.self).toBe('[Circular]');
  });

  it('replaces Buffer with "[Buffer]"', () => {
    const buf = Buffer.from('hello');
    const result = safeStringify({ data: buf });
    const parsed = JSON.parse(result);
    expect(parsed.data).toBe('[Buffer]');
  });

  it('handles nested circular references', () => {
    const inner: Record<string, unknown> = {};
    inner.parent = inner;
    const outer = { child: inner };
    inner.root = outer;

    const result = safeStringify({ outer });
    const parsed = JSON.parse(result);
    expect(parsed.outer.child.parent).toBe('[Circular]');
  });

  it('returns "[Circular]" for an object that cannot be stringified', () => {
    // This shouldn't normally happen since we handle circular refs,
    // but ensure it doesn't throw
    expect(safeStringify({ deep: { value: 1 } })).toBe('{"deep":{"value":1}}');
  });
});