import { describe, it, expect } from 'vitest';
import { planProbes, probeApiEnablement, API_PROBES, type ApiProbeDeps } from '../src/api-probe.js';

const BASE_GRANTED = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/webmasters',
];

function deps(over: Partial<ApiProbeDeps> = {}): ApiProbeDeps {
  return {
    grantedScopes: () => BASE_GRANTED,
    request: async () => {},
    ...over,
  };
}

describe('planProbes', () => {
  it('selects exactly the services whose scopes are granted', () => {
    const services = planProbes(BASE_GRANTED).map((p) => p.service);
    expect(services).toEqual(['gmail', 'drive', 'calendar', 'contacts', 'sheets', 'docs', 'searchconsole']);
  });

  it('adds an optional-bundle service when its scope is granted', () => {
    const services = planProbes([...BASE_GRANTED, 'https://www.googleapis.com/auth/tasks']).map((p) => p.service);
    expect(services).toContain('tasks');
    expect(services).not.toContain('chat');
  });

  it('empty grants → nothing to probe', () => {
    expect(planProbes([])).toEqual([]);
  });

  it('every probe spec carries a console library id and at least one scope prefix', () => {
    for (const p of API_PROBES) {
      expect(p.api).toMatch(/^[a-z0-9-]+$/);
      expect(p.scopePrefixes.length).toBeGreaterThan(0);
    }
  });
});

describe('probeApiEnablement', () => {
  it('all requests succeed → every planned service reports ok', async () => {
    const results = await probeApiEnablement('work', deps());
    expect(results).toHaveLength(7);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('accessNotConfigured → notEnabled for that service, others unaffected', async () => {
    const results = await probeApiEnablement(
      'work',
      deps({
        request: async (_a, url) => {
          if (url.includes('gmail')) {
            throw {
              code: 403,
              errors: [{ reason: 'accessNotConfigured' }],
              message: 'Gmail API has not been used in project 12 before or it is disabled.',
            };
          }
        },
      }),
    );
    const gmail = results.find((r) => r.service === 'gmail')!;
    expect(gmail.notEnabled).toBe(true);
    expect(results.filter((r) => r.ok)).toHaveLength(6);
  });

  it('404 on a bogus-id probe proves enablement (sheets/docs)', async () => {
    const results = await probeApiEnablement(
      'work',
      deps({
        request: async (_a, url) => {
          if (url.includes('/spreadsheets/') || url.includes('/documents/')) {
            throw { code: 404, message: 'Requested entity was not found.' };
          }
        },
      }),
    );
    expect(results.find((r) => r.service === 'sheets')!.ok).toBe(true);
    expect(results.find((r) => r.service === 'docs')!.ok).toBe(true);
  });

  it('an unexpected per-service error is reported, not thrown', async () => {
    const results = await probeApiEnablement(
      'work',
      deps({
        request: async (_a, url) => {
          if (url.includes('webmasters')) throw { code: 403, message: 'forbidden' };
        },
      }),
    );
    const sc = results.find((r) => r.service === 'searchconsole')!;
    expect(sc.ok).toBe(false);
    expect(sc.notEnabled).toBeUndefined();
    expect(sc.message).toBe('forbidden');
  });

  it('a connect-level failure aborts the whole probe run with the code in the message', async () => {
    await expect(
      probeApiEnablement(
        'work',
        deps({
          request: async () => {
            throw { message: 'request to https://gmail.googleapis.com/gmail/v1/users/me/profile failed, reason: ', code: 'ETIMEDOUT' };
          },
        }),
      ),
    ).rejects.toThrow(/ETIMEDOUT/);
  });

  it('no granted scopes → empty result set, no requests made', async () => {
    let called = 0;
    const results = await probeApiEnablement(
      'work',
      deps({ grantedScopes: () => [], request: async () => { called += 1; } }),
    );
    expect(results).toEqual([]);
    expect(called).toBe(0);
  });
});
