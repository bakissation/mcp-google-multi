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

  // B10 noob-proofing hints
  it('403 accessNotConfigured → api_not_enabled with the per-API enable link', () => {
    const e = mapGoogleError({
      code: 403,
      errors: [{ reason: 'accessNotConfigured' }],
      message: 'Access Not Configured. Gmail API has not been used in project 12 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=12 then retry.',
    }, acc);
    expect(e.error).toBe('api_not_enabled');
    expect(e.hint).toContain('console.cloud.google.com/apis/library/gmail.googleapis.com');
  });

  it('403 SERVICE_DISABLED (no URL) → api_not_enabled, generic library link', () => {
    const e = mapGoogleError({
      code: 403,
      response: { data: { error: { status: 'PERMISSION_DENIED', message: 'Drive API is disabled. SERVICE_DISABLED' } } },
    }, acc);
    expect(e.error).toBe('api_not_enabled');
    expect(e.hint).toContain('apis/library');
  });

  it('400 invalid_grant → reauth_required naming the 7-day trap fix', () => {
    const e = mapGoogleError({ code: 400, response: { data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } } }, acc);
    expect(e.error).toBe('reauth_required');
    expect(e.hint).toMatch(/In production/i);
    expect(e.hint).toContain('auth --account work');
  });

  it('401 invalid_grant still routes to the 7-day-trap hint (before generic auth_required)', () => {
    const e = mapGoogleError({ code: 401, message: 'invalid_grant' }, acc);
    expect(e.error).toBe('reauth_required');
    expect(e.hint).toMatch(/7-day/i);
  });

  it('plain 401 (no invalid_grant) stays auth_required', () => {
    expect(mapGoogleError({ code: 401, message: 'Invalid Credentials' }, acc).error).toBe('auth_required');
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
