// Meeting-time search over free/busy blocks: pure date math, no Google calls,
// so it can be tested without a client. Working hours are wall-clock times in
// one IANA time zone; all instants are epoch milliseconds.

export interface BusyBlock { start: number; end: number }

export interface SuggestOptions {
  from: number;
  to: number;
  durationMin: number;
  /** Minutes after local midnight. */
  workStartMin: number;
  workEndMin: number;
  timeZone: string;
  /** Start times land on this wall-clock grid (minutes). */
  stepMin: number;
  /** Quiet time kept free before and after every busy block. */
  bufferMin: number;
  includeWeekends: boolean;
  maxSlots: number;
  maxPerDay: number;
}

export interface Slot { start: number; end: number }

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(timeZone, f);
  }
  return f;
}

/** False for a name Intl does not know (it throws RangeError). */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export interface WallTime { year: number; month: number; day: number; hour: number; minute: number; second: number }

export function wallTime(t: number, timeZone: string): WallTime {
  const p: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(t))) {
    if (part.type !== 'literal') p[part.type] = parseInt(part.value, 10);
  }
  return { year: p.year, month: p.month, day: p.day, hour: p.hour % 24, minute: p.minute, second: p.second };
}

/** Offset of the zone from UTC at instant t, in ms (positive = east of UTC). */
export function offsetMs(t: number, timeZone: string): number {
  const w = wallTime(t, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(t / 1000) * 1000;
}

/** The instant at which the zone's wall clock shows the given date and minute of day. */
export function wallToInstant(year: number, month: number, day: number, minuteOfDay: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day, 0, minuteOfDay);
  const first = guess - offsetMs(guess, timeZone);
  return guess - offsetMs(first, timeZone);
}

/** ISO 8601 with the zone's numeric offset, e.g. 2026-11-04T10:00:00+01:00. */
export function isoWithOffset(t: number, timeZone: string): string {
  const w = wallTime(t, timeZone);
  const off = Math.round(offsetMs(t, timeZone) / 60000);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  const p = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${p(w.year, 4)}-${p(w.month)}-${p(w.day)}T${p(w.hour)}:${p(w.minute)}:${p(w.second)}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

/** "HH:MM" to minutes after midnight, or undefined when malformed. */
export function parseClock(s: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return undefined;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return undefined;
  return h * 60 + min;
}

function mergeBusy(blocks: BusyBlock[], bufferMs: number): BusyBlock[] {
  const sorted = blocks
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
    .map((b) => ({ start: b.start - bufferMs, end: b.end + bufferMs }))
    .sort((a, b) => a.start - b.start);
  const out: BusyBlock[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else out.push({ ...b });
  }
  return out;
}

/** Earliest meeting slots inside working hours that no busy block touches. */
export function suggestSlots(busy: BusyBlock[], o: SuggestOptions): Slot[] {
  const merged = mergeBusy(busy, o.bufferMin * 60_000);
  const durMs = o.durationMin * 60_000;
  const stepMs = o.stepMin * 60_000;
  const slots: Slot[] = [];

  const first = wallTime(o.from, o.timeZone);
  let cursor = Date.UTC(first.year, first.month - 1, first.day);
  for (let guard = 0; guard < 400 && slots.length < o.maxSlots; guard++, cursor += 86_400_000) {
    const day = new Date(cursor);
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const weekday = day.getUTCDay();
    if (!o.includeWeekends && (weekday === 0 || weekday === 6)) continue;

    const dayStart = wallToInstant(y, m, d, o.workStartMin, o.timeZone);
    const dayEnd = wallToInstant(y, m, d, o.workEndMin, o.timeZone);
    if (dayStart >= o.to) break;
    const lo = Math.max(dayStart, o.from);
    const hi = Math.min(dayEnd, o.to);
    if (hi - lo < durMs) continue;

    let free = lo;
    let perDay = 0;
    const gaps: BusyBlock[] = [];
    for (const b of merged) {
      if (b.end <= lo) continue;
      if (b.start >= hi) break;
      if (b.start > free) gaps.push({ start: free, end: Math.min(b.start, hi) });
      free = Math.max(free, b.end);
    }
    if (free < hi) gaps.push({ start: free, end: hi });

    for (const g of gaps) {
      if (perDay >= o.maxPerDay || slots.length >= o.maxSlots) break;
      // Round the start up to the wall-clock grid so slots read 10:00, 10:30.
      const off = offsetMs(g.start, o.timeZone);
      const start = Math.ceil((g.start + off) / stepMs) * stepMs - off;
      if (start + durMs <= g.end) {
        slots.push({ start, end: start + durMs });
        perDay++;
      }
    }
  }
  return slots;
}
