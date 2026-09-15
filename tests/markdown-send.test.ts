import { describe, it, expect } from 'vitest';
import { renderMarkdown, composeRaw } from '../src/tools/gmail-mime.js';

describe('renderMarkdown (A6 D6 send)', () => {
  it('renders headings, links, lists, blockquotes', () => {
    const html = renderMarkdown('# Title\n\n- a\n- b\n\n[link](http://x.com)\n\n> quote');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('<a href="http://x.com">link</a>');
    expect(html).toContain('<blockquote>');
  });

  it('linkifies bare URLs', () => {
    expect(renderMarkdown('see http://example.com now')).toContain('<a href="http://example.com">');
  });

  it('allowRawHtml:false ESCAPES raw HTML (XSS-safe default)', () => {
    const html = renderMarkdown('status <span style="color:red">bad</span>', false);
    expect(html).toContain('&lt;span');
    expect(html).not.toContain('<span');
  });

  it('allowRawHtml:true PASSES raw HTML through (color escape hatch)', () => {
    const html = renderMarkdown('status <span style="color:red">bad</span>', true);
    expect(html).toContain('<span style="color:red">');
  });

  it('BC12 metacharacter trap: plain prose with Markdown chars renders as Markdown', () => {
    // "# 1" becomes a heading, "*x*" becomes emphasis — the documented gotcha.
    const html = renderMarkdown('# 1 thing\n\ncost is *five* dollars');
    expect(html).toContain('<h1>1 thing</h1>');
    expect(html).toContain('<em>five</em>');
  });

  it('multipart/alternative: text/plain is the Markdown SOURCE, text/html is the render', async () => {
    const src = '# Hi\n\n**bold**';
    const raw = await composeRaw({ from: 'm@x', to: 'a@y', subject: 'S', text: src, html: renderMarkdown(src) });
    const msg = Buffer.from(raw, 'base64url').toString('utf-8');
    expect(msg).toContain('multipart/alternative');
    expect(msg).toContain('<strong>bold</strong>'); // html part
    // plain part carries the literal markdown source (base64-encoded in the part)
    const plainPart = msg.split('multipart/alternative')[1];
    expect(plainPart).toBeTruthy();
  });
});
