import { describe, it, expect } from 'vitest';
import { capText, compactResult, logSafe, sliceClean, trimEnabled } from '../src/trim.js';
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

describe('logSafe', () => {
  const ch = (code: number) => String.fromCharCode(code);
  const esc = (code: number) => `\\u${code.toString(16).padStart(4, '0')}`;

  it('escapes every line break, terminal control and bidi or invisible format control, range ends included', () => {
    const unsafe = [
      0x00, 0x09, 0x0a, 0x0d, 0x1b, 0x1f, // C0
      0x7f, 0x80, 0x85, 0x9b, 0x9d, 0x9f, // DEL, C1 (NEL, CSI, OSC)
      0x2028, 0x2029, // line and paragraph separators
      0x061c, 0x200e, 0x200f, 0x202a, 0x202d, 0x202e, 0x2066, 0x2069, // bidi and invisible format controls
    ];
    for (const code of unsafe) expect(logSafe(`a${ch(code)}b`, 10), esc(code)).toBe(`a${esc(code)}b`);
  });

  it('leaves the neighbours of each range alone', () => {
    for (const code of [0x20, 0x7e, 0xa0, 0x061b, 0x061d, 0x200d, 0x2010, 0x2027, 0x202f, 0x2065, 0x206a]) {
      expect(logSafe(`a${ch(code)}b`, 10), esc(code)).toBe(`a${ch(code)}b`);
    }
  });

  it('returns a clean value under the cap unchanged, backslashes included', () => {
    for (const v of ['403 host_rejected', 'C:\\Users\\x', 'caf\u00e9 \u{1F600}', '']) expect(logSafe(v, 64)).toBe(v);
  });

  it('keeps a forged second line on the first one', () => {
    const out = logSafe('x\naudit line lost (forged)\r\n', 100);
    expect(out).toBe('x\\u000aaudit line lost (forged)\\u000d\\u000a');
    expect(out).not.toMatch(/[\r\n\u2028\u2029\p{Cc}]/u);
  });

  it('cuts at max characters and says how long the value was', () => {
    expect(logSafe('a'.repeat(10), 4)).toBe('aaaa...(len=10)');
    expect(logSafe('a'.repeat(4), 4)).toBe('aaaa');
    expect(logSafe(`${'\n'.repeat(5)}tail`, 3)).toBe('\\u000a\\u000a\\u000a...(len=9)');
  });

  it('drops a lone high surrogate at the cut', () => {
    expect(logSafe('aaa\u{1F600}x', 4)).toBe('aaa...(len=6)');
    expect(logSafe('aaa\u{1F600}x', 5)).toBe('aaa\u{1F600}...(len=6)');
  });

  it('is stable when applied again with a cap the first output fits', () => {
    const once = logSafe('a\u2028b\u0085c'.repeat(20), 30);
    expect(logSafe(once, 1000)).toBe(once);
  });

  it('never throws, whatever the value', () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(logSafe({ toString: 1 }, 64)).toBe('<unprintable>');
    expect(logSafe(Object.create(null), 64)).toBe('<unprintable>');
    expect(logSafe(revoked.proxy, 64)).toBe('<unprintable>');
    expect(logSafe({ toString: () => { throw new Error('no'); } }, 64)).toBe('<unprintable>');
    expect(logSafe(Symbol('a\nb'), 64)).toBe('Symbol(a\\u000ab)');
    expect(logSafe(5, 64)).toBe('5');
    expect(logSafe(undefined, 64)).toBe('undefined');
    expect(logSafe(null, 64)).toBe('null');
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
