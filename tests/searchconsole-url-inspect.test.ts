import { describe, it, expect } from 'vitest';
import { toolHarness, parseResult, type GoogleRequest } from './_tool-harness.js';

const SITE = 'https://example.com/';

// Every URL is "indexed" except those containing "bad", which Google rejects.
function inspector() {
  return (req: GoogleRequest): unknown => {
    const body = req.data as { inspectionUrl: string; siteUrl: string };
    if (body.inspectionUrl.includes('bad')) {
      throw Object.assign(new Error('The inspected URL is not under the property.'), {
        code: 400,
        response: { status: 400, data: { error: { code: 400, message: 'The inspected URL is not under the property.', status: 'INVALID_ARGUMENT' } } },
      });
    }
    return { inspectionResult: { indexStatusResult: { verdict: 'PASS', coverageState: `ok ${body.inspectionUrl}` } } };
  };
}

describe('searchconsole_url_inspect', () => {
  it('inspects one URL with inspectionUrl and keeps the original response shape', async () => {
    const h = toolHarness({ respond: inspector() });
    const res = await h.call('searchconsole_url_inspect', { account: 'test', siteUrl: SITE, inspectionUrl: 'https://example.com/a' });
    expect(res.isError).toBeFalsy();
    expect(parseResult(res)).toEqual({ inspectionResult: { indexStatusResult: { verdict: 'PASS', coverageState: 'ok https://example.com/a' } } });
    expect(h.requests()).toHaveLength(1);
    expect(h.requests()[0].data).toMatchObject({ siteUrl: SITE, inspectionUrl: 'https://example.com/a', languageCode: 'en' });
  });

  it('inspects every URL in inspectionUrls, in order, and drops duplicates', async () => {
    const h = toolHarness({ respond: inspector() });
    const res = await h.call('searchconsole_url_inspect', {
      account: 'test', siteUrl: SITE,
      inspectionUrl: 'https://example.com/a',
      inspectionUrls: '["https://example.com/a","https://example.com/b","https://example.com/c"]',
    });
    expect(res.isError).toBeFalsy();
    const out = parseResult(res);
    expect(out).toMatchObject({ inspected: 3, failed: 0 });
    expect(out.results.map((r: { inspectionUrl: string }) => r.inspectionUrl)).toEqual([
      'https://example.com/a', 'https://example.com/b', 'https://example.com/c',
    ]);
    expect(out.results[1]).toMatchObject({ ok: true, inspectionResult: { indexStatusResult: { verdict: 'PASS' } } });
    expect(h.requests()).toHaveLength(3);
  });

  it('a failing URL is reported without stopping the others', async () => {
    const h = toolHarness({ respond: inspector() });
    const res = await h.call('searchconsole_url_inspect', {
      account: 'test', siteUrl: SITE,
      inspectionUrls: ['https://example.com/a', 'https://other.example.org/bad', 'https://example.com/c'],
    });
    expect(res.isError).toBeFalsy();
    const out = parseResult(res);
    expect(out).toMatchObject({ inspected: 2, failed: 1 });
    expect(out.results[1]).toMatchObject({ ok: false, error: 'bad_request' });
  });

  it('is an error only when nothing was inspected', async () => {
    const h = toolHarness({ respond: inspector() });
    const res = await h.call('searchconsole_url_inspect', { account: 'test', siteUrl: SITE, inspectionUrls: ['https://example.com/bad'] });
    expect(res.isError).toBe(true);
    expect(parseResult(res).failed).toBe(1);
  });

  it('refuses no URL, and more than the per-call cap, before calling Google', async () => {
    for (const args of [
      { account: 'test', siteUrl: SITE },
      { account: 'test', siteUrl: SITE, inspectionUrls: [] },
      { account: 'test', siteUrl: SITE, inspectionUrls: Array.from({ length: 21 }, (_, i) => `https://example.com/p${i}`) },
    ]) {
      const h = toolHarness({ respond: inspector() });
      const res = await h.call('searchconsole_url_inspect', args);
      expect(res.isError).toBe(true);
      expect(parseResult(res).error).toBe('invalid_params');
      expect(h.request).not.toHaveBeenCalled();
    }
  });
});
