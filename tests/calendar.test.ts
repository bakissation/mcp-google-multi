import { describe, it, expect } from 'vitest';
import { toolHarness, parseResult, type GoogleRequest } from './_tool-harness.js';

describe('calendar timeMin/timeMax require a timezone suffix', () => {
  it('calendar_list_events rejects a bare local datetime, naming the field', async () => {
    const h = toolHarness({ respond: () => ({ items: [] }) });
    const res = await h.call('calendar_list_events', {
      account: 'test',
      timeMin: '2026-04-04T00:00:00',
      timeMax: '2026-04-05T00:00:00Z',
    });
    const env = parseResult(res);
    expect(res.isError).toBe(true);
    expect(env.error).toBe('invalid_params');
    expect(env.message).toContain('timeMin');
    expect(env.hint).toContain('2026-04-04T00:00:00Z');
    expect(h.request).not.toHaveBeenCalled();
  });

  it('calendar_list_events accepts a numeric offset on both bounds', async () => {
    const h = toolHarness({ respond: () => ({ items: [] }) });
    const res = await h.call('calendar_list_events', {
      account: 'test',
      timeMin: '2026-04-04T00:00:00+01:00',
      timeMax: '2026-04-05T00:00:00+01:00',
    });
    expect(res.isError).toBeFalsy();
    expect(h.request).toHaveBeenCalled();
  });

  it('calendar_list_instances rejects a bare timeMax', async () => {
    const h = toolHarness({ respond: () => ({ items: [] }) });
    const res = await h.call('calendar_list_instances', {
      account: 'test',
      eventId: 'e1',
      timeMin: '2026-04-04T00:00:00Z',
      timeMax: '2026-04-05T00:00:00',
    });
    const env = parseResult(res);
    expect(res.isError).toBe(true);
    expect(env.error).toBe('invalid_params');
    expect(env.message).toContain('timeMax');
    expect(h.request).not.toHaveBeenCalled();
  });

  it('calendar_get_freebusy rejects a bare timeMin before the range check runs', async () => {
    const h = toolHarness({ respond: () => ({}) });
    const res = await h.call('calendar_get_freebusy', {
      account: 'test',
      calendarIds: ['primary'],
      timeMin: '2026-04-04T00:00:00',
      timeMax: '2026-04-05T00:00:00Z',
    });
    const env = parseResult(res);
    expect(res.isError).toBe(true);
    expect(env.error).toBe('invalid_params');
    expect(env.message).toContain('timeMin');
    expect(h.request).not.toHaveBeenCalled();
  });
});

describe('calendar_respond_event', () => {
  const eventWithSelf = {
    id: 'e1',
    attendees: [
      { email: 'other@example.com', responseStatus: 'needsAction' },
      { email: 'me@harness.example', self: true, responseStatus: 'needsAction' },
    ],
  };

  it('patches only the caller own attendee entry via attendeesOmitted', async () => {
    const h = toolHarness({ respond: () => eventWithSelf });
    const res = await h.call('calendar_respond_event', {
      account: 'test',
      eventId: 'e1',
      response: 'accepted',
      comment: 'see you there',
    });
    expect(res.isError).toBeFalsy();
    const patch = h.requests().find((r) => (r.method ?? 'GET').toUpperCase() === 'PATCH');
    expect(patch).toBeDefined();
    const body = (patch as GoogleRequest).data as { attendeesOmitted?: boolean; attendees?: unknown[] };
    expect(body.attendeesOmitted).toBe(true);
    expect(body.attendees).toEqual([{ email: 'me@harness.example', responseStatus: 'accepted', comment: 'see you there' }]);
  });

  it('refuses when the account has no attendee entry on the event, without patching', async () => {
    const h = toolHarness({ respond: () => ({ id: 'e1', attendees: [{ email: 'other@example.com', responseStatus: 'needsAction' }] }) });
    const res = await h.call('calendar_respond_event', { account: 'test', eventId: 'e1', response: 'declined' });
    const env = parseResult(res);
    expect(res.isError).toBe(true);
    expect(env.error).toBe('invalid_params');
    expect(h.requests().some((r) => (r.method ?? 'GET').toUpperCase() === 'PATCH')).toBe(false);
  });

  it('falls back to matching by the account email, case-insensitive, when self is omitted', async () => {
    const h = toolHarness({
      respond: () => ({
        id: 'e1',
        attendees: [
          { email: 'other@example.com', responseStatus: 'needsAction' },
          { email: 'TEST@harness.example', responseStatus: 'needsAction' },
        ],
      }),
    });
    const res = await h.call('calendar_respond_event', { account: 'test', eventId: 'e1', response: 'tentative' });
    expect(res.isError).toBeFalsy();
    const patch = h.requests().find((r) => (r.method ?? 'GET').toUpperCase() === 'PATCH');
    expect(patch).toBeDefined();
    const body = (patch as GoogleRequest).data as { attendeesOmitted?: boolean; attendees?: unknown[] };
    expect(body.attendeesOmitted).toBe(true);
    expect(body.attendees).toEqual([{ email: 'TEST@harness.example', responseStatus: 'tentative' }]);
  });

  it('refuses when no attendee matches self or the account email, without patching', async () => {
    const h = toolHarness({
      respond: () => ({
        id: 'e1',
        attendees: [
          { email: 'other@example.com', responseStatus: 'needsAction' },
          { email: 'someone-else@example.com', responseStatus: 'needsAction' },
        ],
      }),
    });
    const res = await h.call('calendar_respond_event', { account: 'test', eventId: 'e1', response: 'declined' });
    const env = parseResult(res);
    expect(res.isError).toBe(true);
    expect(env.error).toBe('invalid_params');
    expect(h.requests().some((r) => (r.method ?? 'GET').toUpperCase() === 'PATCH')).toBe(false);
  });

  it('sends the chosen response status and comment in the patch body', async () => {
    const h = toolHarness({ respond: () => eventWithSelf });
    const res = await h.call('calendar_respond_event', {
      account: 'test',
      eventId: 'e1',
      response: 'declined',
      comment: 'cannot make it',
    });
    expect(res.isError).toBeFalsy();
    const patch = h.requests().find((r) => (r.method ?? 'GET').toUpperCase() === 'PATCH');
    const body = (patch as GoogleRequest).data as { attendees?: unknown[] };
    expect(body.attendees).toEqual([{ email: 'me@harness.example', responseStatus: 'declined', comment: 'cannot make it' }]);
  });

  it('is gated by write-control like any other update', async () => {
    const h = toolHarness({ respond: () => eventWithSelf, policy: { profile: 'read-only', readOnly: true } });
    const res = await h.call('calendar_respond_event', { account: 'test', eventId: 'e1', response: 'tentative' });
    const env = parseResult(res);
    expect(res.isError).toBe(true);
    expect(env.error).toBe('write_disabled');
  });
});

describe('calendar event time zones on create/update', () => {
  const sent = (h: ReturnType<typeof toolHarness>, verb: string) =>
    (h.requests().find((r) => (r.method ?? 'GET').toUpperCase() === verb) as GoogleRequest | undefined)?.data as
      { start?: unknown; end?: unknown } | undefined;

  it('create sends a distinct zone for each end (a flight)', async () => {
    const h = toolHarness({ respond: (req) => req.data ?? {} });
    const res = await h.call('calendar_create_event', {
      account: 'test',
      summary: 'Flight: ATL -> GCM',
      start: '2026-11-15T09:43:00',
      end: '2026-11-15T12:25:00',
      startTimeZone: 'America/New_York',
      endTimeZone: 'America/Cayman',
    });
    expect(res.isError).toBeFalsy();
    expect(sent(h, 'POST')).toMatchObject({
      start: { dateTime: '2026-11-15T09:43:00', timeZone: 'America/New_York' },
      end: { dateTime: '2026-11-15T12:25:00', timeZone: 'America/Cayman' },
    });
  });

  it('create rejects an offset-less time with no zone, and a zone on an all-day event', async () => {
    for (const args of [
      { start: '2026-11-15T09:43:00', end: '2026-11-15T10:43:00-05:00' },
      { start: '2026-11-15', end: '2026-11-16', allDay: true, startTimeZone: 'America/Cayman' },
      { start: '2026-11-15T09:43:00', end: '2026-11-15T10:43:00', startTimeZone: 'Mars/Base', endTimeZone: 'UTC' },
    ]) {
      const h = toolHarness({ respond: () => ({}) });
      const res = await h.call('calendar_create_event', { account: 'test', summary: 'x', ...args });
      expect(res.isError).toBe(true);
      expect(parseResult(res).error).toBe('invalid_params');
      expect(h.request).not.toHaveBeenCalled();
    }
  });

  it('update with only a zone re-labels the same instant', async () => {
    const current = { id: 'e1', start: { dateTime: '2026-11-16T18:30:00-06:00', timeZone: 'America/Chicago' },
      end: { dateTime: '2026-11-16T20:30:00-06:00', timeZone: 'America/Chicago' } };
    const h = toolHarness({ respond: (req) => ((req.method ?? 'GET').toUpperCase() === 'GET' ? current : req.data) });
    const res = await h.call('calendar_update_event', {
      account: 'test', eventId: 'e1', startTimeZone: 'America/Cayman', endTimeZone: 'America/Cayman',
    });
    expect(res.isError).toBeFalsy();
    expect(sent(h, 'PATCH')).toEqual({
      start: { dateTime: '2026-11-16T18:30:00-06:00', timeZone: 'America/Cayman' },
      end: { dateTime: '2026-11-16T20:30:00-06:00', timeZone: 'America/Cayman' },
    });
  });

  it('update of a time keeps the zone already on that end', async () => {
    const current = { id: 'e1', start: { dateTime: '2026-11-15T09:43:00-05:00', timeZone: 'America/New_York' },
      end: { dateTime: '2026-11-15T12:25:00-05:00', timeZone: 'America/Cayman' } };
    const h = toolHarness({ respond: (req) => ((req.method ?? 'GET').toUpperCase() === 'GET' ? current : req.data) });
    const res = await h.call('calendar_update_event', { account: 'test', eventId: 'e1', end: '2026-11-15T12:40:00' });
    expect(res.isError).toBeFalsy();
    expect(sent(h, 'PATCH')).toEqual({ end: { dateTime: '2026-11-15T12:40:00', timeZone: 'America/Cayman' } });
  });

  it('update refuses a zone for an all-day end, without patching', async () => {
    const h = toolHarness({ respond: () => ({ id: 'e1', start: { date: '2026-11-16' }, end: { date: '2026-11-17' } }) });
    const res = await h.call('calendar_update_event', { account: 'test', eventId: 'e1', startTimeZone: 'America/Cayman' });
    expect(res.isError).toBe(true);
    expect(h.requests().some((r) => (r.method ?? 'GET').toUpperCase() === 'PATCH')).toBe(false);
  });
});
