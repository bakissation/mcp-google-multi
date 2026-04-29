import { describe, it, expect } from 'vitest';
import {
  encodeHeaderValue,
  encodeAddressHeader,
  normalizeBodyLineEndings,
} from '../src/tools/gmail-mime.js';

describe('encodeHeaderValue', () => {
  it('returns empty input unchanged', () => {
    expect(encodeHeaderValue('')).toBe('');
  });

  it('returns ASCII input unchanged', () => {
    expect(encodeHeaderValue('Build complete')).toBe('Build complete');
  });

  it('returns ASCII with all printable specials unchanged', () => {
    const ascii = '!"#$%&\'()*+,-./0-9:;<=>?@A-Z[\\]^_`a-z{|}~';
    expect(encodeHeaderValue(ascii)).toBe(ascii);
  });

  it('encodes a single non-ASCII subject', () => {
    const got = encodeHeaderValue('Hello — world');
    expect(got).toMatch(/^=\?utf-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(decodeEncodedWord(got)).toBe('Hello — world');
  });

  it('encodes Arabic text', () => {
    const subject = 'مرحبا بالعالم';
    const got = encodeHeaderValue(subject);
    expect(decodeEncodedWord(got)).toBe(subject);
  });

  it('encodes emoji', () => {
    const subject = '🚀 Launch update';
    const got = encodeHeaderValue(subject);
    expect(decodeEncodedWord(got)).toBe(subject);
  });

  it('produces a single encoded-word for short non-ASCII input', () => {
    const got = encodeHeaderValue('Hello — world');
    expect(got.split('\r\n ')).toHaveLength(1);
  });

  it('splits long non-ASCII into multiple encoded-words separated by CRLF SPACE', () => {
    const subject = 'مرحبا بالعالم'.repeat(15);
    const got = encodeHeaderValue(subject);
    const parts = got.split('\r\n ');
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p).toMatch(/^=\?utf-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    }
    expect(parts.map(decodeEncodedWord).join('')).toBe(subject);
  });

  it('every encoded-word is at most 75 chars (RFC 2047 hard limit)', () => {
    const subject = 'مرحبا بالعالم'.repeat(20);
    const got = encodeHeaderValue(subject);
    for (const part of got.split('\r\n ')) {
      expect(part.length).toBeLessThanOrEqual(75);
    }
  });

  it('round-trips a wide variety of non-ASCII subjects without corruption', () => {
    const samples = [
      'Hello — world',
      'café résumé naïve',
      '日本語のテスト',
      '🎉 Party 🎉',
      'مرحبا بالعالم',
      'Mixed: Hello مرحبا 🌍',
      'A'.repeat(100) + ' — em-dash at the end',
    ];
    for (const s of samples) {
      const encoded = encodeHeaderValue(s);
      const decoded = encoded.split('\r\n ').map(decodeEncodedWord).join('');
      expect(decoded).toBe(s);
    }
  });
});

describe('encodeAddressHeader', () => {
  it('returns empty input unchanged', () => {
    expect(encodeAddressHeader('')).toBe('');
  });

  it('passes through a bare addr-spec', () => {
    expect(encodeAddressHeader('alice@example.com')).toBe('alice@example.com');
  });

  it('passes through a comma-separated list of bare addr-specs', () => {
    expect(encodeAddressHeader('a@x.com, b@y.com, c@z.com'))
      .toBe('a@x.com, b@y.com, c@z.com');
  });

  it('passes through a named address with an ASCII display name', () => {
    expect(encodeAddressHeader('Alice Smith <alice@example.com>'))
      .toBe('Alice Smith <alice@example.com>');
  });

  it('strips quotes around an ASCII display name', () => {
    expect(encodeAddressHeader('"Alice Smith" <alice@example.com>'))
      .toBe('Alice Smith <alice@example.com>');
  });

  it('encodes only the display name when it contains non-ASCII chars', () => {
    const got = encodeAddressHeader('"محمد" <m@example.com>');
    expect(got).toMatch(/^=\?utf-8\?B\?[A-Za-z0-9+/=]+\?= <m@example\.com>$/);
    const namePart = got.split(' <')[0];
    expect(decodeEncodedWord(namePart)).toBe('محمد');
  });

  it('leaves the addr-spec untouched even when encoding the display name', () => {
    const got = encodeAddressHeader('"محمد" <user+tag.something@sub.example.com>');
    expect(got).toMatch(/<user\+tag\.something@sub\.example\.com>$/);
  });

  it('handles mixed lists — bare, ASCII-named, and non-ASCII-named', () => {
    const got = encodeAddressHeader('Alice <a@x.com>, "محمد" <m@y.com>, c@z.com');
    const parts = got.split(', ');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('Alice <a@x.com>');
    expect(parts[1]).toMatch(/^=\?utf-8\?B\?.+\?= <m@y\.com>$/);
    expect(parts[2]).toBe('c@z.com');
  });

  it('handles an angle-bracketed-only address', () => {
    expect(encodeAddressHeader('<m@example.com>')).toBe('<m@example.com>');
  });

  it('skips empty entries from trailing/duplicate commas', () => {
    expect(encodeAddressHeader('a@x.com, , b@y.com,')).toBe('a@x.com, b@y.com');
  });
});

describe('normalizeBodyLineEndings', () => {
  it('returns empty input unchanged', () => {
    expect(normalizeBodyLineEndings('')).toBe('');
  });

  it('leaves an already-CRLF body unchanged', () => {
    expect(normalizeBodyLineEndings('a\r\nb\r\nc')).toBe('a\r\nb\r\nc');
  });

  it('converts bare LF to CRLF', () => {
    expect(normalizeBodyLineEndings('line1\nline2\n\nline3'))
      .toBe('line1\r\nline2\r\n\r\nline3');
  });

  it('converts bare CR to CRLF', () => {
    expect(normalizeBodyLineEndings('a\rb\rc')).toBe('a\r\nb\r\nc');
  });

  it('normalizes mixed CRLF + LF + CR', () => {
    expect(normalizeBodyLineEndings('a\r\nb\nc\rd')).toBe('a\r\nb\r\nc\r\nd');
  });

  it('preserves blank lines between paragraphs', () => {
    expect(normalizeBodyLineEndings('p1\n\np2\n\np3'))
      .toBe('p1\r\n\r\np2\r\n\r\np3');
  });

  it('does not double-encode an existing CRLF', () => {
    expect(normalizeBodyLineEndings('a\r\nb')).not.toContain('\r\r');
    expect(normalizeBodyLineEndings('a\r\nb')).not.toContain('\n\n');
  });
});

function decodeEncodedWord(encoded: string): string {
  const m = encoded.match(/^=\?utf-8\?B\?([A-Za-z0-9+/=]+)\?=$/);
  if (!m) throw new Error(`Not a base64 encoded-word: ${encoded}`);
  return Buffer.from(m[1], 'base64').toString('utf-8');
}
