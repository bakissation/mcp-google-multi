import { describe, it, expect } from 'vitest';
import {
  encodeHeaderValue,
  encodeAddressHeader,
  normalizeBodyLineEndings,
  buildMultipartAlternative,
  buildReplyHeaders,
  htmlToText,
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

describe('buildMultipartAlternative', () => {
  it('returns a Content-Type with multipart/alternative and a boundary', () => {
    const { contentType } = buildMultipartAlternative('plain', '<p>html</p>');
    expect(contentType).toMatch(/^multipart\/alternative; boundary="[^"]+"$/);
  });

  it('uses a boundary token that meets RFC 2046 bcharsnospace', () => {
    const { contentType } = buildMultipartAlternative('p', 'h');
    const m = contentType.match(/boundary="([^"]+)"/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/^[A-Za-z0-9'()+_,\-./:=?]+$/);
    expect(m![1].length).toBeLessThanOrEqual(70);
  });

  it('emits boundary delimiters around both parts and a closing delimiter', () => {
    const { contentType, body } = buildMultipartAlternative('plain body', '<p>html body</p>');
    const boundary = contentType.match(/boundary="([^"]+)"/)![1];
    expect(body).toContain(`--${boundary}\r\nContent-Type: text/plain`);
    expect(body).toContain(`--${boundary}\r\nContent-Type: text/html`);
    const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(body.trimEnd()).toMatch(new RegExp(`--${escaped}--$`));
  });

  it('places plain part before html part (RFC 2046: clients render the last-listed preferred type)', () => {
    const { body } = buildMultipartAlternative('plain', '<p>html</p>');
    const plainIdx = body.indexOf('Content-Type: text/plain');
    const htmlIdx = body.indexOf('Content-Type: text/html');
    expect(plainIdx).toBeGreaterThan(-1);
    expect(htmlIdx).toBeGreaterThan(plainIdx);
  });

  it('normalizes line endings in both parts to CRLF', () => {
    const { body } = buildMultipartAlternative('p1\np2', '<p>h1</p>\n<p>h2</p>');
    expect(body).toContain('p1\r\np2');
    expect(body).toContain('<p>h1</p>\r\n<p>h2</p>');
    expect(body).not.toMatch(/[^\r]\n/);
  });

  it('uses 8bit encoding for both parts', () => {
    const { body } = buildMultipartAlternative('plain', '<p>html</p>');
    const occurrences = body.match(/Content-Transfer-Encoding: 8bit/g);
    expect(occurrences).toHaveLength(2);
  });

  it('produces a unique boundary per call', () => {
    const a = buildMultipartAlternative('p', 'h').contentType;
    const b = buildMultipartAlternative('p', 'h').contentType;
    expect(a).not.toBe(b);
  });
});

describe('htmlToText', () => {
  it('strips style, script, and head blocks including their content', () => {
    const html = '<head><title>T</title></head><style>body { color: red; }</style>'
      + '<script>if (1 < 2) { alert("x"); }</script><p>Content</p>';
    expect(htmlToText(html)).toBe('Content');
  });

  it('strips HTML comments', () => {
    expect(htmlToText('before<!-- secret note -->after')).toBe('beforeafter');
  });

  it('maps paragraphs to blank-line-separated blocks', () => {
    expect(htmlToText('<p>Hello</p><p>World</p>')).toBe('Hello\n\nWorld');
  });

  it('maps br, headings, list items, and table rows to newlines', () => {
    expect(htmlToText('one<br>two')).toBe('one\ntwo');
    expect(htmlToText('<h1>Title</h1>Body')).toBe('Title\nBody');
    expect(htmlToText('<ul><li>One</li><li>Two</li></ul>')).toBe('One\nTwo');
    expect(htmlToText('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>'))
      .toBe('a b\nc');
  });

  it('collapses HTML source newlines inside a paragraph to spaces', () => {
    expect(htmlToText('<p>line one\n   line two</p>')).toBe('line one line two');
  });

  it('renders links as "text (href)"', () => {
    expect(htmlToText('<a href="https://example.com/page">Read more</a>'))
      .toBe('Read more (https://example.com/page)');
    expect(htmlToText('<a class="btn" href=\'https://y.io\' target="_blank">Click</a>'))
      .toBe('Click (https://y.io)');
  });

  it('omits the href when it duplicates the text or is an anchor', () => {
    expect(htmlToText('<a href="https://example.com">https://example.com</a>'))
      .toBe('https://example.com');
    expect(htmlToText('<a href="#section">Jump</a>')).toBe('Jump');
    expect(htmlToText('<a href="mailto:a@b.co">a@b.co</a>')).toBe('a@b.co');
  });

  it('strips remaining inline tags without adding whitespace', () => {
    expect(htmlToText('<p>Hello <strong>bold</strong> and <em>italic</em></p>'))
      .toBe('Hello bold and italic');
  });

  it('decodes named entities', () => {
    expect(htmlToText('Fish &amp; Chips &lt;tag&gt; &quot;q&quot; &apos;a&apos; &#39;b&#39; A&nbsp;B'))
      .toBe('Fish & Chips <tag> "q" \'a\' \'b\' A B');
  });

  it('decodes decimal and hex numeric entities', () => {
    expect(htmlToText('caf&#233; caf&#xE9; &#x1F600;')).toBe('café café 😀');
  });

  it('decodes double-encoded entities exactly once', () => {
    expect(htmlToText('&amp;lt;')).toBe('&lt;');
  });

  it('leaves unknown and invalid entities untouched', () => {
    expect(htmlToText('&bogus; &#xDFFF; &#1114112;')).toBe('&bogus; &#xDFFF; &#1114112;');
  });

  it('collapses 3+ newlines to 2 and trims line-edge whitespace', () => {
    expect(htmlToText('<p>a</p><br><br><br><p>b</p>')).toBe('a\n\nb');
    expect(htmlToText('<p>text &nbsp; </p><p>next</p>')).toBe('text\n\nnext');
  });
});

describe('buildReplyHeaders', () => {
  it('uses the parent Message-ID for both headers when there are no prior references', () => {
    expect(buildReplyHeaders('gmailid123', '<abc@mail.example.com>', ''))
      .toEqual({ inReplyTo: '<abc@mail.example.com>', references: '<abc@mail.example.com>' });
  });

  it('appends the parent Message-ID to the existing references chain', () => {
    expect(buildReplyHeaders('gmailid123', '<c@x.com>', '<a@x.com> <b@x.com>'))
      .toEqual({ inReplyTo: '<c@x.com>', references: '<a@x.com> <b@x.com> <c@x.com>' });
  });

  it('unfolds folded references whitespace into single spaces', () => {
    expect(buildReplyHeaders('g', '<c@x.com>', '<a@x.com>\r\n <b@x.com>').references)
      .toBe('<a@x.com> <b@x.com> <c@x.com>');
  });

  it('falls back to the Gmail API id when the Message-ID header is absent', () => {
    expect(buildReplyHeaders('gmailid123', '', ''))
      .toEqual({ inReplyTo: 'gmailid123', references: 'gmailid123' });
    expect(buildReplyHeaders('gmailid123', '   ', '<a@x.com>'))
      .toEqual({ inReplyTo: 'gmailid123', references: 'gmailid123' });
  });
});

function decodeEncodedWord(encoded: string): string {
  const m = encoded.match(/^=\?utf-8\?B\?([A-Za-z0-9+/=]+)\?=$/);
  if (!m) throw new Error(`Not a base64 encoded-word: ${encoded}`);
  return Buffer.from(m[1], 'base64').toString('utf-8');
}
