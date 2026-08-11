import { describe, it, expect } from 'vitest';
import {
  normalizeBodyLineEndings,
  buildReplyHeaders,
  htmlToText,
} from '../src/tools/gmail-mime.js';

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
