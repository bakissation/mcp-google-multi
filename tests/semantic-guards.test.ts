import { describe, it, expect } from 'vitest';
import { timeRangeError } from '../src/tools/calendar.js';
import { invalidParams } from '../src/tools/_errors.js';

// events.list answers 200 with [] on a backwards window, which reads as
// "nothing scheduled", while the sibling freebusy.query 400s on the identical
// input. Deciding locally makes an empty list always mean empty.
describe('timeRangeError', () => {
  it('rejects an inverted window and names both bounds', () => {
    const e = timeRangeError('2026-09-22T00:00:00Z', '2026-09-21T00:00:00Z');
    expect(e).toContain('2026-09-22T00:00:00Z');
    expect(e).toContain('2026-09-21T00:00:00Z');
    expect(e).toContain('after');
  });

  it('rejects a zero-length window as containing nothing', () => {
    expect(timeRangeError('2026-09-21T10:00:00Z', '2026-09-21T10:00:00Z')).toContain('same instant');
  });

  it('accepts a normal window', () => {
    expect(timeRangeError('2026-09-21T00:00:00Z', '2026-09-22T00:00:00Z')).toBeNull();
  });

  // Date.parse is more lenient than RFC 3339, so it may only SKIP the check.
  // A value Google would reject still reaches Google and maps as before.
  it('stays out of the way when a bound is missing or unparseable', () => {
    expect(timeRangeError(undefined, '2026-09-21T00:00:00Z')).toBeNull();
    expect(timeRangeError('2026-09-21T00:00:00Z', undefined)).toBeNull();
    expect(timeRangeError(undefined, undefined)).toBeNull();
    expect(timeRangeError('not a date', '2026-09-21T00:00:00Z')).toBeNull();
  });
});

describe('invalidParams', () => {
  it('answers with the same envelope shape as every other failure', () => {
    const r = invalidParams('work' as never, 'x is empty', 'pass a real x');
    expect(r.isError).toBe(true);
    const env = JSON.parse(r.content[0].text);
    expect(env).toEqual({
      error: 'invalid_params',
      message: 'x is empty',
      hint: 'pass a real x',
      retriable: false,
      account: 'work',
    });
  });
});
