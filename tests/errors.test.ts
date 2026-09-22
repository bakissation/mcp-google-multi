import { describe, it, expect } from 'vitest';
import { mapGoogleError, stringifyEnvelope } from '../src/tools/_errors.js';

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

  // One hint slot used to serve both meanings, which is how a pure resource
  // denial came back telling the caller to add a scope bundle they already had.
  it('403 generic → forbidden, and a bare service hint no longer lands there', () => {
    const e = mapGoogleError({ code: 403, message: 'forbidden' }, acc, 'enable admin writes');
    expect(e.error).toBe('forbidden');
    expect(e.hint).not.toBe('enable admin writes');
    expect(e.hint).toContain('shared with this account');
  });

  it('a bare service hint is the SCOPE hint, and only fires on the scope reason', () => {
    const scoped = mapGoogleError(
      { code: 403, errors: [{ reason: 'insufficientPermissions' }], message: 'Insufficient Permission' },
      acc,
      'enable admin writes',
    );
    expect(scoped.error).toBe('insufficient_scope');
    expect(scoped.hint).toBe('enable admin writes');
  });

  it('a resource hint fires only on a resource denial', () => {
    const denied = mapGoogleError({ code: 403, message: 'forbidden' }, acc, { resource: 'share the file first' });
    expect(denied.hint).toBe('share the file first');
    const scoped = mapGoogleError(
      { code: 403, errors: [{ reason: 'insufficientPermissions' }], message: 'Insufficient Permission' },
      acc,
      { resource: 'share the file first' },
    );
    expect(scoped.error).toBe('insufficient_scope');
    expect(scoped.hint).not.toBe('share the file first');
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

  it('every branch carries a hint (upstream passthroughs included)', () => {
    const cases = [
      { code: 403, message: 'Forbidden' }, // forbidden, no service hint
      { code: 400, message: 'invalid_scope: bad' },
      { code: 404, message: 'x' },
      { code: 503, message: 'unavailable' }, // 5xx upstream_error
      { code: 400, message: 'Invalid value for field' }, // 400 fallback
      { message: 'something odd' }, // statusless fallback
    ];
    for (const c of cases) {
      const e = mapGoogleError(c, acc);
      expect(e.hint, `no hint for ${JSON.stringify(c)}`).toBeTruthy();
    }
  });

  // A caller-side 4xx and a Google outage used to share `upstream_error`.
  it('a caller-side 400 is bad_request, not upstream_error', () => {
    const e = mapGoogleError({ code: 400, message: 'Invalid value for maxResults' }, acc);
    expect(e.error).toBe('bad_request');
    expect(e.retriable).toBe(false);
    expect(e.hint).toContain('argument');
  });

  it('other caller-side 4xx keep the slug and name the status', () => {
    const conflict = mapGoogleError({ code: 409, message: 'conflict' }, acc);
    expect(conflict.error).toBe('bad_request');
    expect(conflict.retriable).toBe(false);
    expect(conflict.hint).toContain('409');
  });

  it('not_found hints at the account-specific ID trap', () => {
    const e = mapGoogleError({ code: 404, message: 'File not found' }, acc);
    expect(e.hint).toContain('account-specific');
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

  it('GA4 429 (property tokens) → rate_limited with the quota-bucket hint', () => {
    const e = mapGoogleError(
      { code: 429, message: 'Exhausted property tokens for a project per hour. These quota tokens will return in under an hour.' },
      acc,
    );
    expect(e.error).toBe('rate_limited');
    expect(e.retriable).toBe(true);
    expect(e.hint).toContain('returnPropertyQuota');
    expect(e.hint).toContain('Narrow the date range');
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

  // Connect-level failures (no HTTP status): the gaxios path flattens the
  // happy-eyeballs AggregateError into a bare code with an empty message.
  it('gaxios/node-fetch empty-reason ETIMEDOUT → network_error, retriable, code surfaced', () => {
    const e = mapGoogleError(
      { message: 'request to https://oauth2.googleapis.com/token failed, reason: ', code: 'ETIMEDOUT', type: 'system' },
      acc,
    );
    expect(e.error).toBe('network_error');
    expect(e.retriable).toBe(true);
    expect(e.message).toBe('request to https://oauth2.googleapis.com/token failed, reason: ETIMEDOUT');
    expect(e.hint).toContain('network-family-autoselection');
  });

  it('undici fetch failed → network_error via cause AggregateError sub-errors', () => {
    const e = mapGoogleError(
      { message: 'fetch failed', cause: { message: '', errors: [{ code: 'ENETUNREACH' }, { code: 'ETIMEDOUT' }] } },
      acc,
    );
    expect(e.error).toBe('network_error');
    expect(e.retriable).toBe(true);
    expect(e.message).toContain('ENETUNREACH');
  });

  it('ENOTFOUND (bad hostname) → network_error but not retriable', () => {
    const e = mapGoogleError({ message: 'getaddrinfo ENOTFOUND example.invalid', code: 'ENOTFOUND' }, acc);
    expect(e.error).toBe('network_error');
    expect(e.retriable).toBe(false);
    expect(e.message).toBe('getaddrinfo ENOTFOUND example.invalid');
  });

  it('a real HTTP status still wins over a network-looking cause', () => {
    const e = mapGoogleError({ code: 503, message: 'unavailable', cause: { code: 'ECONNRESET' } }, acc);
    expect(e.error).toBe('upstream_error');
    expect(e.retriable).toBe(true);
  });

  // A throw with no gaxios shape never left this process, so blaming Google
  // for it is how an empty messageId surfaced as an upstream failure.
  it('a statusless throw with no request shape is internal, not upstream', () => {
    const e = mapGoogleError({ message: 'something odd' }, acc);
    expect(e.error).toBe('internal');
    expect(e.retriable).toBe(false);
    expect(e.hint).toContain('inside the MCP server');
  });

  it('a statusless error that DID leave the process stays upstream_error', () => {
    const e = mapGoogleError({ message: 'socket hang up', config: { url: 'https://x' } }, acc);
    expect(e.error).toBe('upstream_error');
    expect(e.retriable).toBe(false);
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

describe('mapGoogleError local-filesystem paths', () => {
  it('ENOENT on a caller-supplied path → invalid_params with the remote-path hint', () => {
    const err = Object.assign(new Error("ENOENT: no such file or directory, open '/data/missing.pdf'"), {
      code: 'ENOENT',
      path: '/data/missing.pdf',
    });
    const e = mapGoogleError(err, acc);
    expect(e.error).toBe('invalid_params');
    expect(e.message).toContain('/data/missing.pdf');
    expect(e.message).toContain('ENOENT');
    expect(e.hint).toContain('machine running this server');
    expect(e.retriable).toBe(false);
  });

  it('EACCES and EISDIR map the same way; the path is optional', () => {
    for (const code of ['EACCES', 'EISDIR']) {
      const e = mapGoogleError(Object.assign(new Error(`${code}: denied`), { code }), acc);
      expect(e.error).toBe('invalid_params');
      expect(e.message).toContain(code);
    }
  });

  it('network string codes are NOT treated as local-fs errors', () => {
    const e = mapGoogleError(Object.assign(new Error('request failed'), { code: 'ETIMEDOUT' }), acc);
    expect(e.error).toBe('network_error');
  });

  it('numeric Google statuses are untouched by the local-fs branch', () => {
    const e = mapGoogleError({ code: 404, message: 'File not found: abc' }, acc);
    expect(e.error).toBe('not_found');
  });
});

// gaxios copies the ENTIRE response body into error.message when the body is a
// string, which is how 8.5 KB of Google's HTML front-end page ended up inside
// a JSON error envelope.
describe('non-JSON bodies never reach the envelope', () => {
  const acc = 'work' as never;
  const htmlPage = `<!DOCTYPE html><html><head><title>Error 404</title></head><body>${'x'.repeat(9000)}</body></html>`;

  it('suppresses an HTML body and says what was suppressed', () => {
    const e = mapGoogleError(
      { code: 404, message: htmlPage, response: { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' }, data: htmlPage } },
      acc,
    );
    expect(e.message).not.toContain('<html');
    expect(e.message).toContain('HTML error page');
    expect(e.message).toContain('chars suppressed');
    expect(e.message.length).toBeLessThan(200);
  });

  it('detects markup with no Content-Type, including a bare tag', () => {
    for (const body of ['<h1>Server Error</h1>', '<div>oops</div>', '<!-- nope -->', '<?xml version="1.0"?><Error/>']) {
      const e = mapGoogleError({ code: 500, message: body }, acc);
      expect(e.message, body).toContain('non-JSON error body');
    }
  });

  it('does not mistake a normal sentence containing < for markup', () => {
    const e = mapGoogleError({ code: 400, message: 'value must be < 100' }, acc);
    expect(e.message).toBe('value must be < 100');
  });

  it('prefers the structured Google message over the raw body', () => {
    const body = JSON.stringify({ error: { code: 400, message: 'Invalid value for orgUnitId' } });
    const e = mapGoogleError(
      { code: 400, message: body, response: { status: 400, headers: { 'content-type': 'application/json' }, data: body } },
      acc,
    );
    expect(e.message).toBe('Invalid value for orgUnitId');
  });

  it('caps a very long plain-text message instead of passing it through', () => {
    const e = mapGoogleError({ code: 400, message: 'z'.repeat(50_000) }, acc);
    expect(e.message.length).toBeLessThan(1200);
    expect(e.message).toContain('50000 chars total');
  });

  it('bounds the SERIALIZED envelope, hint included', () => {
    const text = stringifyEnvelope({
      error: 'forbidden',
      message: 'm'.repeat(50_000),
      hint: 'h'.repeat(50_000),
      retriable: false,
      account: 'work',
    });
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(JSON.parse(text).error).toBe('forbidden');
  });
});

describe('AIP-193 details[] classification', () => {
  const acc = 'work' as never;
  const withInfo = (status: number, reason: string, metadata?: Record<string, string>) => ({
    code: status,
    message: 'denied',
    response: {
      status,
      headers: { 'content-type': 'application/json' },
      data: { error: { code: status, status: 'PERMISSION_DENIED', message: 'denied', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'googleapis.com', ...(metadata ? { metadata } : {}) }] } },
    },
  });

  it('reads the scope reason out of details[], where modern APIs put it', () => {
    const e = mapGoogleError(withInfo(403, 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'), acc);
    expect(e.error).toBe('insufficient_scope');
  });

  it('a bare PERMISSION_DENIED is a resource denial, NOT a scope problem', () => {
    const e = mapGoogleError(
      { code: 403, message: 'The caller does not have permission', response: { status: 403, headers: { 'content-type': 'application/json' }, data: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } } } },
      acc,
    );
    expect(e.error).toBe('forbidden');
    expect(e.hint).not.toMatch(/scope bundle|re-auth/i);
  });

  it('SERVICE_DISABLED deep-links using the metadata, not a message scrape', () => {
    const e = mapGoogleError(withInfo(403, 'SERVICE_DISABLED', { service: 'chat.googleapis.com', consumer: 'projects/12345' }), acc);
    expect(e.error).toBe('api_not_enabled');
    expect(e.hint).toContain('chat.googleapis.com');
    expect(e.hint).toContain('project=12345');
  });

  it('a 403 that is really a quota answers rate_limited, not forbidden', () => {
    const e = mapGoogleError({ code: 403, errors: [{ reason: 'userRateLimitExceeded' }], message: 'Rate Limit Exceeded' }, acc);
    expect(e.error).toBe('rate_limited');
    expect(e.retriable).toBe(true);
  });

  it('routes wrong-file-type 403s to the sibling tool instead of blaming permissions', () => {
    const dl = mapGoogleError({ code: 403, errors: [{ reason: 'fileNotDownloadable' }], message: 'Only files with binary content can be downloaded.' }, acc);
    expect(dl.error).toBe('binary_unsupported');
    expect(dl.hint).toContain('drive_export');
    const ex = mapGoogleError({ code: 403, errors: [{ reason: 'fileNotExportable' }], message: 'Export only supports Docs Editors files.' }, acc);
    expect(ex.error).toBe('binary_unsupported');
    expect(ex.hint).toContain('drive_download');
  });
});

describe('local preconditions are not Google failures', () => {
  const acc = 'work' as never;
  it.each([
    ['E_NO_TOKEN', 'auth_required'],
    ['E_UNKNOWN_ACCOUNT', 'validation_error'],
    ['E_NO_OAUTH_CLIENT', 'invalid_client'],
  ])('%s maps to %s', (code, slug) => {
    const e = mapGoogleError(Object.assign(new Error('nope'), { code }), acc);
    expect(e.error).toBe(slug);
    expect(e.retriable).toBe(false);
  });
});
