import { describe, it, expect } from 'vitest';
import { mapGoogleError } from '../src/tools/_errors.js';

const acc = 'work';

describe('mapGoogleError', () => {
  it('401 → auth_required with a re-auth hint', () => {
    const e = mapGoogleError({ code: 401, message: 'Invalid Credentials' }, acc);
    expect(e.error).toBe('auth_required');
    expect(e.retriable).toBe(false);
    expect(e.hint).toContain('auth --account work');
  });

  it('403 insufficientPermissions → insufficient_scope', () => {
    const e = mapGoogleError(
      { code: 403, errors: [{ reason: 'insufficientPermissions' }], message: 'Insufficient Permission' },
      acc,
    );
    expect(e.error).toBe('insufficient_scope');
  });

  it('403 generic → forbidden, passes the hint through', () => {
    const e = mapGoogleError({ code: 403, message: 'forbidden' }, acc, 'enable admin writes');
    expect(e.error).toBe('forbidden');
    expect(e.hint).toBe('enable admin writes');
  });

  it('404 → not_found', () => {
    expect(mapGoogleError({ code: 404, message: 'x' }, acc).error).toBe('not_found');
  });

  it('429 → rate_limited, retriable, with Retry-After', () => {
    const e = mapGoogleError(
      { code: 429, message: 'quota', response: { headers: { 'retry-after': '30' } } },
      acc,
    );
    expect(e.error).toBe('rate_limited');
    expect(e.retriable).toBe(true);
    expect(e.hint).toContain('30');
  });

  it('5xx → upstream_error, retriable', () => {
    const e = mapGoogleError({ code: 503, message: 'unavailable' }, acc);
    expect(e.error).toBe('upstream_error');
    expect(e.retriable).toBe(true);
  });

  it('never leaks the Authorization header / token from the raw error', () => {
    const e = mapGoogleError(
      {
        code: 403,
        message: 'Forbidden',
        config: { headers: { Authorization: 'Bearer SECRET' } },
        response: { data: { access_token: 'SECRET' } },
      },
      acc,
    );
    const json = JSON.stringify(e);
    expect(json).not.toContain('SECRET');
    expect(json).not.toContain('Authorization');
  });

  it('reads the nested Google message + reason', () => {
    const e = mapGoogleError(
      { response: { status: 404, data: { error: { message: 'Not found here', errors: [{ reason: 'notFound' }] } } } },
      acc,
    );
    expect(e.error).toBe('not_found');
    expect(e.message).toBe('Not found here');
  });
});
