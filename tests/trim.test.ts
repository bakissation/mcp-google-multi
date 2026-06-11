import { describe, it, expect } from 'vitest';
import { capText, compactResult, sliceClean, trimEnabled } from '../src/trim.js';
import { formatEvent } from '../src/tools/calendar.js';
import { parseMessage } from '../src/tools/gmail.js';

describe('trimEnabled', () => {
  it('defaults on, disabled by off-values', () => {
    expect(trimEnabled({})).toBe(true);
    expect(trimEnabled({ GOOGLE_TRIM: 'on' })).toBe(true);
    expect(trimEnabled({ GOOGLE_TRIM: 'off' })).toBe(false);
    expect(trimEnabled({ GOOGLE_TRIM: 'false' })).toBe(false);
    expect(trimEnabled({ GOOGLE_TRIM: '0' })).toBe(false);
  });
});

describe('capText', () => {
  it('returns untruncated text as-is', () => {
    expect(capText('hello', 10)).toEqual({ text: 'hello', truncated: false, totalChars: 5 });
  });

  it('caps and reports totals', () => {
    expect(capText('abcdefghij', 4)).toEqual({ text: 'abcd', truncated: true, totalChars: 10 });
  });

  it('supports offsets for paging', () => {
    expect(capText('abcdefghij', 4, 8)).toEqual({ text: 'ij', truncated: false, totalChars: 10 });
    expect(capText('abcdefghij', 4, 4)).toEqual({ text: 'efgh', truncated: true, totalChars: 10 });
  });

  it('offset past the end terminates paging cleanly', () => {
    expect(capText('abcdefghij', 4, 10)).toEqual({ text: '', truncated: false, totalChars: 10 });
    expect(capText('abcdefghij', 4, 15)).toEqual({ text: '', truncated: false, totalChars: 10 });
  });
});

describe('sliceClean', () => {
  it('drops a trailing lone high surrogate so output stays well-formed', () => {
    const text = `${'a'.repeat(3)}😀`;
    expect(sliceClean(text, 4)).toBe('aaa');
    expect(sliceClean(text, 5)).toBe(`${'a'.repeat(3)}😀`);
    expect(sliceClean('plain', 3)).toBe('pla');
  });
});

describe('parseMessage body cap', () => {
  const msg = (body: string) => ({
    id: 'm1',
    threadId: 't1',
    payload: { headers: [], body: { data: Buffer.from(body, 'utf-8').toString('base64url') } },
  });

  it('does not flag a body exactly at the cap', () => {
    const out = parseMessage(msg('a'.repeat(100)), 100);
    expect(out.body).toHaveLength(100);
    expect(out.bodyTruncated).toBeUndefined();
    expect(out.bodyTotalChars).toBeUndefined();
  });

  it('caps and flags a body one char over', () => {
    const out = parseMessage(msg('a'.repeat(101)), 100);
    expect(out.body).toHaveLength(100);
    expect(out.bodyTruncated).toBe(true);
    expect(out.bodyTotalChars).toBe(101);
  });

  it('never ends a capped body with a lone surrogate', () => {
    const out = parseMessage(msg(`${'a'.repeat(99)}😀x`), 100);
    expect(out.body).toBe('a'.repeat(99));
    expect(out.bodyTruncated).toBe(true);
  });

  it('returns the full body when no cap is given', () => {
    const out = parseMessage(msg('a'.repeat(200)));
    expect(out.body).toHaveLength(200);
    expect(out.bodyTruncated).toBeUndefined();
  });
});

describe('compactResult', () => {
  it('compacts pretty-printed JSON text blocks', () => {
    const result = { content: [{ type: 'text', text: JSON.stringify({ a: 1, b: [2, 3] }, null, 2) }] };
    expect(compactResult(result).content[0].text).toBe('{"a":1,"b":[2,3]}');
  });

  it('leaves non-JSON text and error flags untouched', () => {
    const result = {
      content: [{ type: 'text', text: 'plain sentence' }],
      isError: true as const,
    };
    const out = compactResult(result);
    expect(out.content[0].text).toBe('plain sentence');
    expect(out.isError).toBe(true);
  });

  it('handles arrays and multiple content items', () => {
    const result = {
      content: [
        { type: 'text', text: '[\n  1,\n  2\n]' },
        { type: 'image', text: undefined as never },
      ],
    };
    expect(compactResult(result).content[0].text).toBe('[1,2]');
  });
});

describe('formatEvent trimming', () => {
  const FAT_EVENT = {
    id: 'e1',
    summary: 'Standup',
    description: 'x'.repeat(500),
    location: '',
    start: { dateTime: '2026-06-11T09:00:00Z' },
    end: { dateTime: '2026-06-11T09:15:00Z' },
    status: 'confirmed',
    htmlLink: 'https://cal/link',
    organizer: { email: 'a@b.c' },
    attendees: [],
    recurringEventId: 'r1',
    hangoutLink: 'https://meet/abc',
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-02T00:00:00Z',
  };

  it('list mode caps description, drops created/updated and empty fields', () => {
    const e = formatEvent(FAT_EVENT, { full: false }) as Record<string, unknown>;
    expect((e.description as string).length).toBeLessThan(400);
    expect(e.description as string).toContain('[truncated');
    expect(e.created).toBeUndefined();
    expect(e.updated).toBeUndefined();
    expect(e).not.toHaveProperty('location');
    expect(e).not.toHaveProperty('attendees');
    expect(e.recurringEventId).toBe('r1');
    expect(e.hangoutLink).toBe('https://meet/abc');
  });

  it('full mode keeps everything', () => {
    const e = formatEvent(FAT_EVENT) as Record<string, unknown>;
    expect((e.description as string).length).toBe(500);
    expect(e.created).toBe('2026-01-01T00:00:00Z');
    expect(e.location).toBe('');
  });

  it('never truncates when the marker would make the output longer', () => {
    const e = formatEvent({ ...FAT_EVENT, description: 'x'.repeat(320) }, { full: false }) as Record<string, unknown>;
    expect(e.description).toBe('x'.repeat(320));
  });
});
