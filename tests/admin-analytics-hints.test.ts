import { describe, it, expect } from 'vitest';
import { toolHarness, accountSet, parseResult as parse, type GoogleRequest } from './_tool-harness.js';
import { resolveReportsWindow } from '../src/tools/admin.js';

const ACCOUNTS = () =>
  accountSet(
    { test: { email: 'test@harness.example', scopeProfile: 'full', admin: true } },
    { defaultAccount: 'test', scopeProfiles: { full: { bundles: ['analytics'] } } },
  );

function harness(respond: (req: GoogleRequest) => unknown) {
  const h = toolHarness({
    accounts: ACCOUNTS(),
    requestImpl: async (req: GoogleRequest) => {
      const out = respond(req);
      if (out instanceof Error) throw out;
      return { data: out, headers: new Headers(), status: 200 };
    },
  });
  return { call: h.call, requests: () => h.requests() as GoogleRequest[] };
}

const google400 = (message: string) =>
  Object.assign(new Error(message), { code: 400, response: { status: 400, data: { error: { code: 400, message } } } });

describe('reports_activities_list window', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');

  it('defaults endTime to now when only startTime is given', () => {
    expect(resolveReportsWindow('drive', '2026-10-01T00:00:00Z', undefined, now)).toEqual({ endTime: '2026-11-03T12:00:00.000Z' });
  });

  it('leaves a request with no bounds alone for a non-gmail application', () => {
    expect(resolveReportsWindow('login', undefined, undefined, now)).toEqual({ endTime: undefined });
  });

  it('gmail needs startTime and a window of at most 30 days', () => {
    expect(resolveReportsWindow('gmail', undefined, undefined, now)).toHaveProperty('problem');
    expect(resolveReportsWindow('gmail', '2026-10-01T00:00:00Z', undefined, now)).toHaveProperty('problem');
    expect(resolveReportsWindow('gmail', '2026-10-10T00:00:00Z', undefined, now)).toEqual({ endTime: '2026-11-03T12:00:00.000Z' });
    expect(resolveReportsWindow('gmail', '2026-10-01T00:00:00Z', '2026-10-31T00:00:00Z', now)).toEqual({ endTime: '2026-10-31T00:00:00Z' });
  });

  it('rejects a timestamp that does not parse', () => {
    expect(resolveReportsWindow('drive', 'yesterday', undefined, now)).toHaveProperty('problem');
  });

  it('sends the defaulted endTime to Google and refuses an over-long gmail window before any call', async () => {
    const h = harness(() => ({ items: [] }));
    const ok = await h.call('reports_activities_list', { account: 'test', applicationName: 'drive', startTime: '2026-10-01T00:00:00Z' });
    expect(ok.isError).toBeFalsy();
    const sent = h.requests()[0] as { params?: Record<string, string> };
    expect(sent.params?.startTime).toBe('2026-10-01T00:00:00Z');
    expect(sent.params?.endTime).toMatch(/^20\d\d-/);
    const bad = await h.call('reports_activities_list', { account: 'test', applicationName: 'gmail', startTime: '2020-01-01T00:00:00Z' });
    expect(parse(bad).error).toBe('invalid_params');
    expect(h.requests()).toHaveLength(1);
  });
});

describe('admin_users_get with a group address', () => {
  it('says a group is not a user and where to look instead', async () => {
    const h = harness(() => google400('Type not supported: userKey'));
    const env = parse(await h.call('admin_users_get', { account: 'test', userKey: 'team@example.com' }));
    expect(env.error).toBe('bad_request');
    expect(env.hint).toContain('admin_groups_list');
  });

  it('other 400s keep the generic hint', async () => {
    const h = harness(() => google400('Invalid Input: orgUnitPath'));
    const env = parse(await h.call('admin_users_get', { account: 'test', userKey: 'a@example.com' }));
    expect(env.hint).not.toContain('admin_groups_list');
  });
});

describe('analytics incompatible dimension and metric', () => {
  it('points at the metadata and compatibility check', async () => {
    const h = harness(() => google400('Dimensions and metrics cannot be queried together: country, sessions.'));
    const env = parse(await h.call('analytics_run_realtime_report', { account: 'test', property: '123456', metrics: ['sessions'], dimensions: ['country'] }));
    expect(env.error).toBe('bad_request');
    expect(env.hint).toContain('analytics_get_metadata');
    expect(env.hint).toContain('checkCompatibility');
  });
});
