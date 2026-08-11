import { describe, it, expect } from 'vitest';
import { htmlToMarkdown } from '../src/tools/gmail-mime.js';

// D6 read: the HTML->Markdown converter behind gmail read's `markdown`
// bodyFormat. The parseMessage-level discriminator matrix (plain/markdown/html)
// lives in gmail-read.test.ts; this suite pins the converter's own contract.
describe('htmlToMarkdown (A7 D6 read)', () => {
  it('converts headings, links, and lists to Markdown', () => {
    const { text, ok } = htmlToMarkdown(
      '<h1>Title</h1><p>see <a href="http://x.com">link</a></p><ul><li>a</li></ul>',
    );
    expect(ok).toBe(true);
    expect(text).toContain('# Title');
    expect(text).toContain('[link](http://x.com)');
    expect(text).toContain('-   a');
  });

  it('emits GFM tables via the plugin', () => {
    const { text, ok } = htmlToMarkdown(
      '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>',
    );
    expect(ok).toBe(true);
    expect(text).toContain('| A | B |');
    expect(text).toContain('| --- | --- |');
    expect(text).toContain('| 1 | 2 |');
  });

  it('strips script/style/head content (never leaks JS/CSS into the body)', () => {
    const { text } = htmlToMarkdown(
      '<head><title>t</title></head><p>hi</p><script>evil()</script><style>x{color:red}</style>',
    );
    expect(text).toContain('hi');
    expect(text).not.toContain('evil()');
    expect(text).not.toContain('color:red');
  });

  it('preserves GFM strikethrough from the plugin', () => {
    const { text } = htmlToMarkdown('<p><del>gone</del></p>');
    expect(text).toContain('~gone~');
  });
});
