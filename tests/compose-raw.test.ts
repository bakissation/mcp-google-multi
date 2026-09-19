import { describe, it, expect } from 'vitest';
import { composeRaw, HeaderInjectionError } from '../src/tools/gmail-mime.js';

function decode(b64: string): string {
  return Buffer.from(b64, 'base64url').toString('utf-8');
}

describe('composeRaw (A4 MailComposer)', () => {
  it('plain body: text/plain, CRLF-only, From/To/Subject present', async () => {
    const msg = decode(await composeRaw({ from: 'me@x.com', to: 'a@y.com', subject: 'Hi', text: 'l1\nl2' }));
    expect(msg).toMatch(/^From: me@x\.com/m);
    expect(msg).toMatch(/^To: a@y\.com/m);
    expect(msg).toMatch(/^Subject: Hi/m);
    expect(msg).toContain('text/plain');
    expect(msg).not.toMatch(/[^\r]\n/); // no bare LF anywhere
  });

  it('non-ASCII subject is RFC 2047 encoded', async () => {
    const msg = decode(await composeRaw({ from: 'me@x.com', to: 'a@y.com', subject: 'Réunion café ☕', text: 'b' }));
    expect(msg).toMatch(/Subject:\s*=\?UTF-8\?B\?/i);
  });

  it('html body produces multipart/alternative with both parts', async () => {
    const msg = decode(await composeRaw({ from: 'me@x.com', to: 'a@y.com', subject: 'S', text: 'plain', html: '<p>rich</p>' }));
    expect(msg).toContain('multipart/alternative');
    expect(msg).toContain('text/plain');
    expect(msg).toContain('text/html');
  });

  it('attachment yields multipart/mixed with the filename and content-type', async () => {
    const msg = decode(await composeRaw({
      from: 'me@x.com', to: 'a@y.com', subject: 'S', text: 'b',
      attachments: [{ filename: 'report.pdf', content: Buffer.from('%PDF-1.4 test'), contentType: 'application/pdf' }],
    }));
    expect(msg).toContain('multipart/mixed');
    expect(msg).toMatch(/application\/pdf/);
    expect(msg).toMatch(/report\.pdf/);
  });

  it('reply headers appear when provided', async () => {
    const msg = decode(await composeRaw({ from: 'm@x', to: 'a@y', subject: 'Re', text: 'b', inReplyTo: '<abc@mail>', references: '<r1@mail> <abc@mail>' }));
    expect(msg).toMatch(/In-Reply-To:\s*<abc@mail>/i);
    expect(msg).toMatch(/References:.*<abc@mail>/i);
  });

  it('CRLF in a header field is rejected (E_HEADER_INJECTION), never composed', async () => {
    for (const bad of [
      { from: 'me@x.com', to: 'a@y.com\r\nBcc: evil@z.com', subject: 'S', text: 'b' },
      { from: 'me@x.com', to: 'a@y.com', subject: 'S\r\nBcc: evil@z.com', text: 'b' },
      { from: 'me@x.com', to: 'a@y.com', subject: 'S', cc: 'c@z\ninjected', text: 'b' },
    ]) {
      await expect(composeRaw(bad)).rejects.toBeInstanceOf(HeaderInjectionError);
    }
  });

  it('CRLF inside the BODY is allowed (normalized), not an injection', async () => {
    const msg = decode(await composeRaw({ from: 'm@x', to: 'a@y', subject: 'S', text: 'line1\nline2\r\nline3' }));
    expect(msg).toContain('line1');
    expect(msg).not.toMatch(/[^\r]\n/);
  });
});
