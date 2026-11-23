import { describe, it, expect } from 'vitest';
import { buildReplyQuote } from '../src/tools/gmail-mime.js';
import { toolHarness, type GoogleRequest } from './_tool-harness.js';

// The Gmail API adds no quoted original to a raw message, so a reply built
// from `body` alone reaches the recipient (and the Drafts folder) without the
// mail it answers. replyToMessageId now appends it unless quoteOriginal:false.

const b64 = (s: string): string => Buffer.from(s, 'utf-8').toString('base64url');

/** Decode the text/plain and text/html parts of a composed raw message. */
function parts(raw: string): { text: string; html: string } {
  const msg = Buffer.from(raw, 'base64url').toString('utf-8');
  const boundary = /boundary="([^"]+)"/.exec(msg)?.[1] ?? '';
  const sections = msg.split(`--${boundary}`);
  const part = (type: string): string => {
    const section = sections.find((s) => s.includes(`Content-Type: ${type}`)) ?? '';
    const content = section.slice(section.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '');
    return section.includes('Content-Transfer-Encoding: base64')
      ? Buffer.from(content.replace(/\r\n/g, ''), 'base64').toString('utf-8')
      : content;
  };
  return { text: part('text/plain'), html: part('text/html') };
}

const headers = [
  { name: 'From', value: 'Alice <alice@ext.com>' },
  { name: 'To', value: 'test@harness.example' },
  { name: 'Subject', value: 'Question' },
  { name: 'Date', value: 'Mon, 23 Nov 2026 10:00:00 +0100' },
  { name: 'Message-ID', value: '<src@ext>' },
];

const fullSource = {
  id: 'SRC1',
  threadId: 'THREAD-7',
  payload: {
    mimeType: 'multipart/alternative',
    headers,
    parts: [
      { mimeType: 'text/plain', body: { data: b64('Can you confirm?\n\nAlice') } },
      { mimeType: 'text/html', body: { data: b64('<html><head><style>p{color:red}</style></head><body><p>Can you <b>confirm</b>?</p><script>x()</script></body></html>') } },
    ],
  },
};

const source = (req: GoogleRequest): unknown | undefined =>
  req.method === 'GET' && req.url.includes('/messages/SRC1') ? fullSource : undefined;

describe('buildReplyQuote', () => {
  it('quotes the plain body line by line under an attribution line', () => {
    const q = buildReplyQuote({ from: 'Alice <alice@ext.com>', date: 'Mon, 23 Nov 2026 10:00:00 +0100', plain: 'one\n\ntwo', html: '' });
    expect(q?.text).toBe('On Mon, 23 Nov 2026 10:00:00 +0100, Alice <alice@ext.com> wrote:\n> one\n>\n> two\n');
  });

  it('wraps the source HTML in a Gmail quote block, without its document wrappers or scripts', () => {
    const q = buildReplyQuote({ from: 'a@b.c', date: '', plain: '', html: '<html><head><title>t</title></head><body><p>Hi</p><script>x()</script></body></html>' });
    expect(q?.html).toContain('<blockquote class="gmail_quote"');
    expect(q?.html).toContain('<p>Hi</p>');
    expect(q?.html).not.toMatch(/<\/?(html|head|body|script)\b/i);
    expect(q?.html).not.toContain('x()');
    expect(q?.html).toContain('a@b.c wrote:');
  });

  describe('script and head tags in an HTML source', () => {
    const quote = (html: string): string => buildReplyQuote({ from: 'a@b.c', date: '', plain: '', html })?.html ?? '';
    const inner = (html: string): string => {
      const out = quote(html);
      return out.slice(out.indexOf('padding-left:1ex">') + 'padding-left:1ex">'.length, out.indexOf('</blockquote>'));
    };
    const live = /<\/?(html|head|body|script)\b/i;

    it('leaves no live script tag when removing one joins its neighbours into another', () => {
      for (const html of [
        '<scr<script></script>ipt>alert(1)</script>',
        '<scr<script>x</script>ipt>alert(1)</scr<script>x</script>ipt>',
        '<<script></script>script>alert(1)',
        '<he<head></head>ad><title>t</title></head>',
      ]) {
        expect(inner(html)).not.toMatch(live);
      }
    });

    it('drops a script or head block that never closes, with everything after it', () => {
      expect(inner('<p>a</p><script>alert(1)<p>b</p>')).toBe('<p>a</p>');
      expect(inner('<p>a</p><script')).toBe('<p>a</p>');
      expect(inner('x<head><title>t</title><p>b</p>')).toBe('x');
    });

    it('escapes a stray closing script or head that has no end bracket', () => {
      expect(inner('<p>a</p></script')).toBe('<p>a</p>&lt;/script');
      expect(inner('x</HEAD')).toBe('x&lt;/HEAD');
      expect(inner('<p>a</p><body')).toBe('<p>a</p>&lt;body');
    });

    it('removes stray closing tags and wrappers that carry attributes', () => {
      expect(inner('</script><p>a</p></head><body class="x" onload="y()"><p>b</p></body></html>')).toBe('<p>a</p><p>b</p>');
    });

    it('treats the tag names case-insensitively', () => {
      expect(inner('<SCRIPT>x()</SCRIPT><p>ok</p><ScRiPt')).toBe('<p>ok</p>');
      expect(inner('<HEAD><TITLE>t</TITLE></HEAD><BODY><p>ok</p></BODY>')).toBe('<p>ok</p>');
    });

    it('keeps the block boundaries right when a character changes length in lower case', () => {
      expect(inner('<p>\u0130\u0130\u0130</p><script>x()</script><p>ok</p>')).toBe('<p>\u0130\u0130\u0130</p><p>ok</p>');
    });

    it('does not touch names that only start with a stripped one', () => {
      expect(inner('<p>a</p><header>h</header><scripture>s</scripture><bodyguard>b</bodyguard>'))
        .toBe('<p>a</p><header>h</header><scripture>s</scripture><bodyguard>b</bodyguard>');
    });

    it('keeps an ordinary HTML mail unchanged apart from its document wrappers', () => {
      const body = '<div dir="ltr"><p>Hello <b>Bob</b>,</p><ul><li>one</li><li><a href="https://x.y/?a=1&amp;b=2">two</a></li></ul><table><tr><td>1 &lt; 2</td></tr></table><img src="cid:logo"><br>Alice</div>';
      expect(inner(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>p{margin:0}</style></head><body>${body}</body></html>`)).toBe(body);
      expect(inner(body)).toBe(body);
    });
  });

  it('escapes a plain-only source in the HTML part and the attribution', () => {
    const q = buildReplyQuote({ from: 'Eve <eve@x.y>', date: '', plain: '<b>not bold</b>\nnext', html: '' });
    expect(q?.html).toContain('&lt;b&gt;not bold&lt;/b&gt;<br>');
    expect(q?.html).toContain('Eve &lt;eve@x.y&gt; wrote:');
  });

  it('derives the plain quote from an HTML-only source', () => {
    const q = buildReplyQuote({ from: 'a@b.c', date: '', plain: '', html: '<p>Hello <b>there</b></p>' });
    expect(q?.text).toContain('> Hello **there**');
  });

  it('returns nothing for a source with no text body', () => {
    expect(buildReplyQuote({ from: 'a@b.c', date: 'd', plain: '', html: '' })).toBeUndefined();
  });
});

describe('replies quote the original message', () => {
  it('gmail_create_draft appends the source to both parts and fetches it in full', async () => {
    const h = toolHarness({ respond: (req) => source(req) ?? { id: 'd1', message: { id: 'm1', threadId: 'THREAD-7' } } });
    const res = await h.call('gmail_create_draft', { account: 'test', body: 'Yes, **confirmed**.', replyToMessageId: 'SRC1' });
    expect(res.isError).toBeUndefined();
    const get = h.requests().find((r) => r.method === 'GET' && r.url.includes('/messages/SRC1'));
    expect(get?.params).toMatchObject({ format: 'full' });
    const create = h.requests().find((r) => r.method === 'POST' && r.url.includes('/drafts'));
    const { text, html } = parts((create?.data as any).message.raw);
    expect(text).toBe('Yes, **confirmed**.\n\nOn Mon, 23 Nov 2026 10:00:00 +0100, Alice <alice@ext.com> wrote:\n> Can you confirm?\n>\n> Alice\n'.replace(/\n/g, '\r\n'));
    expect(html).toContain('<strong>confirmed</strong>');
    expect(html).toContain('<p>Can you <b>confirm</b>?</p>');
    expect(html.indexOf('<strong>confirmed</strong>')).toBeLessThan(html.indexOf('gmail_quote'));
    expect(html).not.toContain('x()');
  });

  it('gmail_send quotes the source too', async () => {
    const h = toolHarness({ respond: (req) => source(req) ?? { id: 'sent', threadId: 'THREAD-7' } });
    await h.call('gmail_send', { account: 'test', body: 'ok', replyToMessageId: 'SRC1' });
    const send = h.requests().find((r) => r.method === 'POST' && r.url.includes('/messages/send'));
    expect(parts((send?.data as any).raw).text).toContain('> Can you confirm?');
  });

  it('quoteOriginal:false keeps the bare reply and the metadata-only fetch', async () => {
    const h = toolHarness({ respond: (req) => source(req) ?? { id: 'd1', message: { id: 'm1' } } });
    await h.call('gmail_create_draft', { account: 'test', body: 'ok', replyToMessageId: 'SRC1', quoteOriginal: false });
    const get = h.requests().find((r) => r.method === 'GET' && r.url.includes('/messages/SRC1'));
    expect(get?.params).toMatchObject({ format: 'metadata' });
    const create = h.requests().find((r) => r.method === 'POST' && r.url.includes('/drafts'));
    const { text, html } = parts((create?.data as any).message.raw);
    expect(text).toBe('ok');
    expect(html).not.toContain('gmail_quote');
  });

  it('a mail that is not a reply carries no quote', async () => {
    const h = toolHarness({ respond: () => ({ id: 'd1', message: { id: 'm1' } }) });
    await h.call('gmail_create_draft', { account: 'test', to: 'a@b.com', subject: 's', body: 'b' });
    const create = h.requests().find((r) => r.method === 'POST' && r.url.includes('/drafts'));
    expect(parts((create?.data as any).message.raw).html).not.toContain('gmail_quote');
  });
});
