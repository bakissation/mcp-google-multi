import { describe, it, expect } from 'vitest';
import { toolHarness, parseResult, type GoogleRequest } from './_tool-harness.js';
import { isoWithOffset, parseClock, suggestSlots, wallToInstant, type SuggestOptions } from '../src/tools/_suggest-times.js';

const Z = (s: string) => Date.parse(s);

const base = (over: Partial<SuggestOptions> = {}): SuggestOptions => ({
  from: Z('2026-11-02T00:00:00Z'),
  to: Z('2026-11-09T00:00:00Z'),
  durationMin: 30,
  workStartMin: 9 * 60,
  workEndMin: 17 * 60,
  timeZone: 'Europe/Paris',
  stepMin: 30,
  bufferMin: 0,
  includeWeekends: false,
  maxSlots: 5,
  maxPerDay: 3,
  ...over,
});

describe('suggestSlots', () => {
  it('starts at the beginning of working hours on a free calendar, in the zone', () => {
    const [first] = suggestSlots([], base());
    expect(new Date(first.start).toISOString()).toBe('2026-11-02T08:00:00.000Z'); // 09:00 CET
    expect(first.end - first.start).toBe(30 * 60_000);
  });

  it('keeps clear of busy blocks and merges overlapping ones', () => {
    const slots = suggestSlots(
      [
        { start: Z('2026-11-02T08:00:00Z'), end: Z('2026-11-02T10:00:00Z') },
        { start: Z('2026-11-02T09:00:00Z'), end: Z('2026-11-02T11:00:00Z') },
      ],
      base({ maxSlots: 1 }),
    );
    expect(new Date(slots[0].start).toISOString()).toBe('2026-11-02T11:00:00.000Z');
  });

  it('aligns starts to the wall-clock grid', () => {
    const slots = suggestSlots([{ start: Z('2026-11-02T08:00:00Z'), end: Z('2026-11-02T08:10:00Z') }], base({ maxSlots: 1 }));
    expect(isoWithOffset(slots[0].start, 'Europe/Paris')).toBe('2026-11-02T09:30:00+01:00');
  });

  it('skips weekends unless asked, and never returns more than maxPerDay a day', () => {
    const fri = base({ from: Z('2026-11-06T00:00:00Z'), to: Z('2026-11-10T00:00:00Z'), maxSlots: 20 });
    // No busy blocks: one gap per day, so one slot per day.
    const weekdays = suggestSlots([], fri).map((s) => isoWithOffset(s.start, 'Europe/Paris').slice(0, 10));
    expect(weekdays).toEqual(['2026-11-06', '2026-11-09']);
    const withWeekends = suggestSlots([], { ...fri, includeWeekends: true }).map((s) => isoWithOffset(s.start, 'Europe/Paris').slice(0, 10));
    expect(withWeekends).toEqual(['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09']);

    const busy = [10, 12, 14, 16].map((h) => ({ start: Z(`2026-11-02T${String(h - 1).padStart(2, '0')}:30:00Z`), end: Z(`2026-11-02T${String(h - 1).padStart(2, '0')}:45:00Z`) }));
    const monday = suggestSlots(busy, base({ to: Z('2026-11-03T00:00:00Z'), maxSlots: 20 }));
    expect(monday).toHaveLength(3);
  });

  it('keeps a buffer around busy blocks', () => {
    const busy = [{ start: Z('2026-11-02T08:30:00Z'), end: Z('2026-11-02T09:00:00Z') }];
    const none = suggestSlots(busy, base({ maxSlots: 1, from: Z('2026-11-02T08:00:00Z'), to: Z('2026-11-02T09:30:00Z') }));
    expect(none).toEqual([{ start: Z('2026-11-02T08:00:00Z'), end: Z('2026-11-02T08:30:00Z') }]);
    const buffered = suggestSlots(busy, base({ bufferMin: 15, maxSlots: 1, from: Z('2026-11-02T08:00:00Z'), to: Z('2026-11-02T09:30:00Z') }));
    expect(buffered).toEqual([]);
  });

  it('does not offer time before the window starts or a slot that overruns the window end', () => {
    const slots = suggestSlots([], base({ from: Z('2026-11-02T12:10:00Z'), to: Z('2026-11-02T12:50:00Z') }));
    expect(slots).toEqual([]);
    const ok = suggestSlots([], base({ from: Z('2026-11-02T12:10:00Z'), to: Z('2026-11-02T13:10:00Z') }));
    expect(ok).toEqual([{ start: Z('2026-11-02T12:30:00Z'), end: Z('2026-11-02T13:00:00Z') }]);
  });

  it('returns nothing when no gap is long enough', () => {
    const busy = [{ start: Z('2026-11-02T08:00:00Z'), end: Z('2026-11-02T16:00:00Z') }];
    expect(suggestSlots(busy, base({ to: Z('2026-11-03T00:00:00Z'), durationMin: 60 }))).toEqual([]);
  });
});

describe('wall-clock helpers', () => {
  it('map wall time to the right instant on both sides of a DST change', () => {
    expect(new Date(wallToInstant(2026, 3, 6, 9 * 60, 'America/New_York')).toISOString()).toBe('2026-03-06T14:00:00.000Z'); // EST
    expect(new Date(wallToInstant(2026, 3, 9, 9 * 60, 'America/New_York')).toISOString()).toBe('2026-03-09T13:00:00.000Z'); // EDT
  });

  it('format an instant with its numeric offset, including half-hour zones', () => {
    expect(isoWithOffset(Z('2026-11-02T08:00:00Z'), 'Europe/Paris')).toBe('2026-11-02T09:00:00+01:00');
    expect(isoWithOffset(Z('2026-11-02T08:00:00Z'), 'Asia/Kolkata')).toBe('2026-11-02T13:30:00+05:30');
    expect(isoWithOffset(Z('2026-11-02T03:00:00Z'), 'America/New_York')).toBe('2026-11-01T22:00:00-05:00');
  });

  it('parse HH:MM clocks and reject nonsense', () => {
    expect(parseClock('09:30')).toBe(570);
    expect(parseClock('24:00')).toBe(1440);
    for (const bad of ['9', '25:00', '10:60', 'noon', '']) expect(parseClock(bad), bad).toBeUndefined();
  });
});

describe('calendar_suggest_times', () => {
  const freebusy = (calendars: Record<string, unknown>) => (req: GoogleRequest): unknown => {
    if (req.url.includes('freeBusy')) return { calendars };
    return { id: 'primary', timeZone: 'Europe/Paris' };
  };
  const args = { account: 'test', timeMin: '2026-11-02T00:00:00Z', timeMax: '2026-11-09T00:00:00Z' };

  it('finds slots free for everyone, in the primary calendar zone', async () => {
    const h = toolHarness({
      respond: freebusy({
        primary: { busy: [{ start: '2026-11-02T08:00:00Z', end: '2026-11-02T09:30:00Z' }] },
        'bob@example.com': { busy: [{ start: '2026-11-02T10:00:00Z', end: '2026-11-02T11:00:00Z' }] },
      }),
    });
    const res = await h.call('calendar_suggest_times', { ...args, attendees: ['bob@example.com'], maxSuggestions: 3 });
    expect(res.isError).toBeFalsy();
    const out = parseResult(res);
    expect(out.timeZone).toBe('Europe/Paris');
    expect(out.checked).toEqual(['primary', 'bob@example.com']);
    expect(out.slots.map((s: { start: string }) => s.start)).toEqual([
      '2026-11-02T10:30:00+01:00',
      '2026-11-02T12:00:00+01:00',
      '2026-11-03T09:00:00+01:00',
    ]);
    expect(out.slots[0]).toMatchObject({ end: '2026-11-02T11:00:00+01:00', startUtc: '2026-11-02T09:30:00.000Z' });
    const fb = h.requests().find((r) => r.url.includes('freeBusy'))!;
    expect(fb.data).toMatchObject({ items: [{ id: 'primary' }, { id: 'bob@example.com' }] });
  });

  it('works on your own calendar when no attendees are given, and honours timeZone and working hours', async () => {
    const h = toolHarness({ respond: freebusy({ primary: { busy: [] } }) });
    const res = await h.call('calendar_suggest_times', { ...args, timeZone: 'America/New_York', workStart: '10:00', workEnd: '11:00', durationMinutes: 60, maxSuggestions: 1 });
    const out = parseResult(res);
    expect(out.timeZone).toBe('America/New_York');
    expect(out.slots[0].start).toBe('2026-11-02T10:00:00-05:00');
    // The zone was given, so the primary calendar is not looked up.
    expect(h.requests().some((r) => !r.url.includes('freeBusy'))).toBe(false);
  });

  it('says so, and does not count them as free, when an attendee calendar cannot be read', async () => {
    const h = toolHarness({
      respond: freebusy({
        primary: { busy: [] },
        'ghost@example.com': { busy: [], errors: [{ domain: 'global', reason: 'notFound' }] },
      }),
    });
    const res = await h.call('calendar_suggest_times', { ...args, attendees: ['ghost@example.com'], maxSuggestions: 1 });
    expect(res.isError).toBeFalsy();
    const out = parseResult(res);
    expect(out.unavailable).toEqual([{ calendar: 'ghost@example.com', reason: 'notFound' }]);
    expect(out.warning).toContain('NOT taken into account');
    expect(out.checked).toEqual(['primary']);
  });

  it('is an error when your own free/busy cannot be read', async () => {
    const h = toolHarness({ respond: freebusy({ primary: { busy: [], errors: [{ reason: 'forbidden' }] } }) });
    const res = await h.call('calendar_suggest_times', args);
    expect(res.isError).toBe(true);
    expect(parseResult(res).error).toBe('invalid_params');
  });

  it('gives a hint when nothing is free', async () => {
    const h = toolHarness({ respond: freebusy({ primary: { busy: [{ start: '2026-11-02T00:00:00Z', end: '2026-11-09T00:00:00Z' }] } }) });
    const out = parseResult(await h.call('calendar_suggest_times', args));
    expect(out.slots).toEqual([]);
    expect(out.hint).toContain('Widen');
  });

  it('rejects bad input before calling Google', async () => {
    const cases: Record<string, unknown>[] = [
      { ...args, timeMin: '2026-11-02T00:00:00' },
      { ...args, workStart: '17:00', workEnd: '09:00' },
      { ...args, workStart: 'nine' },
      { ...args, timeZone: 'Mars/Olympus' },
      { account: 'test', timeMin: '2026-11-02T00:00:00Z', timeMax: '2026-12-31T00:00:00Z' },
      { ...args, timeMax: '2026-11-01T00:00:00Z' },
      { ...args, attendees: Array.from({ length: 21 }, (_, i) => `p${i}@example.com`) },
    ];
    for (const c of cases) {
      const h = toolHarness({ respond: freebusy({}) });
      const res = await h.call('calendar_suggest_times', c);
      expect(res.isError, JSON.stringify(c)).toBe(true);
      expect(parseResult(res).error).toBe('invalid_params');
      expect(h.request).not.toHaveBeenCalled();
    }
  });
});
