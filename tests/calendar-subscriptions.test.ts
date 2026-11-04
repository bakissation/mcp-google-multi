import { describe, it, expect } from 'vitest';
import { toolHarness, parseResult, type GoogleRequest } from './_tool-harness.js';

const only = (h: ReturnType<typeof toolHarness>, method: string) =>
  h.requests().filter((r) => (r.method ?? 'GET').toUpperCase() === method) as GoogleRequest[];

describe('calendar list subscriptions', () => {
  it('calendar_add_subscription inserts the calendar by id with the given display settings', async () => {
    const h = toolHarness({ respond: (req) => req.data ?? {} });
    const res = await h.call('calendar_add_subscription', {
      account: 'test', calendarId: 'team@example.com', summaryOverride: 'Team', hidden: 'false',
    });
    expect(res.isError).toBeFalsy();
    const [req] = only(h, 'POST');
    expect(req.url).toContain('/users/me/calendarList');
    expect(req.data).toEqual({ id: 'team@example.com', summaryOverride: 'Team', hidden: false });
    expect(req.params?.colorRgbFormat).toBeUndefined();
  });

  it('asks for RGB colours only when a hex colour is given', async () => {
    const h = toolHarness({ respond: (req) => req.data ?? {} });
    await h.call('calendar_add_subscription', {
      account: 'test', calendarId: 'team@example.com', backgroundColor: '#16a765', foregroundColor: '#000000',
    });
    expect(only(h, 'POST')[0].params).toMatchObject({ colorRgbFormat: true });
  });

  it('rejects a colour that is not #rrggbb before calling Google', async () => {
    const h = toolHarness({ respond: () => ({}) });
    const res = await h.call('calendar_add_subscription', { account: 'test', calendarId: 'x@example.com', backgroundColor: 'green' });
    expect(res.isError).toBe(true);
    expect(h.request).not.toHaveBeenCalled();
  });

  it('calendar_update_subscription patches only the fields passed', async () => {
    const h = toolHarness({ respond: (req) => req.data ?? {} });
    const res = await h.call('calendar_update_subscription', { account: 'test', calendarId: 'team@example.com', selected: true, colorId: '9' });
    expect(res.isError).toBeFalsy();
    const [req] = only(h, 'PATCH');
    expect(decodeURIComponent(req.url)).toContain('/users/me/calendarList/team@example.com');
    expect(req.data).toEqual({ selected: true, colorId: '9' });
  });

  it('calendar_update_subscription refuses an empty change', async () => {
    const h = toolHarness({ respond: () => ({}) });
    const res = await h.call('calendar_update_subscription', { account: 'test', calendarId: 'team@example.com' });
    expect(res.isError).toBe(true);
    expect(parseResult(res).error).toBe('invalid_params');
    expect(h.request).not.toHaveBeenCalled();
  });

  it('calendar_remove_subscription deletes from the list and says what was removed', async () => {
    const h = toolHarness({ respond: () => ({}) });
    const res = await h.call('calendar_remove_subscription', { account: 'test', calendarId: 'team@example.com' });
    expect(res.isError).toBeFalsy();
    expect(parseResult(res)).toEqual({ removed: true, calendarId: 'team@example.com' });
    const [req] = only(h, 'DELETE');
    expect(decodeURIComponent(req.url)).toContain('/users/me/calendarList/team@example.com');
  });

  it('is refused under a read-only policy with the usual write hint', async () => {
    const h = toolHarness({ policy: { profile: 'read-only' }, respond: () => ({}) });
    const res = await h.call('calendar_remove_subscription', { account: 'test', calendarId: 'team@example.com' });
    expect(res.isError).toBe(true);
    expect(h.request).not.toHaveBeenCalled();
  });
});
