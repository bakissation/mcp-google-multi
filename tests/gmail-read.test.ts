import { describe, it, expect } from 'vitest';
import { parseMessage } from '../src/tools/gmail.js';

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');

const textPart = (mimeType: string, text: string) => ({
  mimeType,
  filename: '',
  body: { data: b64(text) },
});

const msg = (payload: unknown, extra: Record<string, unknown> = {}) => ({
  id: 'm1',
  threadId: 't1',
  payload,
  ...extra,
});

describe('parseMessage body selection', () => {
  it('prefers nested text/plain over a sibling text/html part', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        textPart('text/html', '<p>html version</p>'),
        {
          mimeType: 'multipart/alternative',
          parts: [textPart('text/plain', 'plain version')],
        },
      ],
    };
    const out = parseMessage(msg(payload));
    expect(out.body).toBe('plain version');
    expect(out.bodyOrigin).toBe('text/plain');
  });

  it('prefers text/plain in a classic multipart/alternative', () => {
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [
        textPart('text/plain', 'plain'),
        textPart('text/html', '<p>html</p>'),
      ],
    };
    const out = parseMessage(msg(payload));
    expect(out.body).toBe('plain');
    expect(out.bodyOrigin).toBe('text/plain');
  });

  it('concatenates sequential text/plain parts of the same container', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        textPart('text/plain', 'intro'),
        textPart('text/plain', 'forwarded body'),
      ],
    };
    const out = parseMessage(msg(payload));
    expect(out.body).toBe('intro\n\nforwarded body');
    expect(out.bodyOrigin).toBe('text/plain');
  });

  it('converts an HTML-only message to plain text', () => {
    const out = parseMessage(msg(textPart('text/html', '<p>Hello <strong>world</strong></p>')));
    expect(out.body).toBe('Hello world');
    expect(out.bodyOrigin).toBe('text/html');
  });

  it('concatenates multiple HTML parts before converting', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        textPart('text/html', '<p>one</p>'),
        textPart('text/html', '<p>two</p>'),
      ],
    };
    const out = parseMessage(msg(payload));
    expect(out.body).toBe('one\n\ntwo');
    expect(out.bodyOrigin).toBe('text/html');
  });

  it('returns the raw HTML body when rawHtml is set', () => {
    const out = parseMessage(msg(textPart('text/html', '<p>Hi</p>')), undefined, { rawHtml: true });
    expect(out.body).toBe('<p>Hi</p>');
    expect(out.bodyOrigin).toBe('text/html');
  });

  it('still prefers text/plain when rawHtml is set', () => {
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [
        textPart('text/plain', 'plain'),
        textPart('text/html', '<p>html</p>'),
      ],
    };
    const out = parseMessage(msg(payload), undefined, { rawHtml: true });
    expect(out.body).toBe('plain');
    expect(out.bodyOrigin).toBe('text/plain');
  });

  it('applies the body cap to the converted text, not the raw HTML', () => {
    const html = `<p>${'a'.repeat(40)}</p>`.repeat(3);
    const converted = [`${'a'.repeat(40)}`, `${'a'.repeat(40)}`, `${'a'.repeat(40)}`].join('\n\n');
    expect(html.length).toBeGreaterThan(130);

    const uncapped = parseMessage(msg(textPart('text/html', html)), 130);
    expect(uncapped.body).toBe(converted);
    expect(uncapped.bodyTruncated).toBeUndefined();

    const capped = parseMessage(msg(textPart('text/html', html)), 100);
    expect(capped.body).toBe(converted.slice(0, 100));
    expect(capped.bodyTruncated).toBe(true);
    expect(capped.bodyTotalChars).toBe(converted.length);
  });

  it('omits bodyOrigin when the message has no body', () => {
    const out = parseMessage(msg({ mimeType: 'multipart/mixed', parts: [] }));
    expect(out.body).toBe('');
    expect(out.bodyOrigin).toBeUndefined();
  });
});

describe('parseMessage header and resource fields', () => {
  it('surfaces Message-ID, In-Reply-To, References, labelIds, and internalDate', () => {
    const headers = [
      { name: 'Subject', value: 'S' },
      { name: 'Message-ID', value: '<mid@example.com>' },
      { name: 'In-Reply-To', value: '<parent@example.com>' },
      { name: 'References', value: '<a@x.com> <parent@example.com>' },
    ];
    const out = parseMessage(msg(
      { headers, body: { data: b64('hi') } },
      { labelIds: ['INBOX', 'UNREAD'], internalDate: '1720000000000' },
    ));
    expect(out.messageIdHeader).toBe('<mid@example.com>');
    expect(out.inReplyTo).toBe('<parent@example.com>');
    expect(out.references).toBe('<a@x.com> <parent@example.com>');
    expect(out.labelIds).toEqual(['INBOX', 'UNREAD']);
    expect(out.internalDate).toBe('1720000000000');
  });

  it('omits the additive fields when absent from the message', () => {
    const out = parseMessage(msg({ headers: [], body: { data: b64('x') } }));
    expect(out.messageIdHeader).toBeUndefined();
    expect(out.inReplyTo).toBeUndefined();
    expect(out.references).toBeUndefined();
    expect(out.labelIds).toBeUndefined();
    expect(out.internalDate).toBeUndefined();
  });
});

describe('parseMessage attachments', () => {
  it('surfaces sizeBytes, partId, and inline detection', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        textPart('text/plain', 'body'),
        {
          partId: '1',
          mimeType: 'application/pdf',
          filename: 'report.pdf',
          headers: [{ name: 'Content-Disposition', value: 'attachment; filename="report.pdf"' }],
          body: { attachmentId: 'att-1', size: 12345 },
        },
        {
          partId: '2',
          mimeType: 'image/png',
          filename: 'logo.png',
          headers: [{ name: 'Content-Disposition', value: 'inline; filename="logo.png"' }],
          body: { attachmentId: 'att-2', size: 999 },
        },
        {
          partId: '3',
          mimeType: 'image/gif',
          filename: 'sig.gif',
          headers: [{ name: 'Content-ID', value: '<sig@cid>' }],
          body: { attachmentId: 'att-3', size: 111 },
        },
      ],
    };
    const out = parseMessage(msg(payload));
    expect(out.body).toBe('body');
    expect(out.attachments).toEqual([
      { filename: 'report.pdf', attachmentId: 'att-1', mimeType: 'application/pdf', sizeBytes: 12345, partId: '1' },
      { filename: 'logo.png', attachmentId: 'att-2', mimeType: 'image/png', sizeBytes: 999, partId: '2', inline: true },
      { filename: 'sig.gif', attachmentId: 'att-3', mimeType: 'image/gif', sizeBytes: 111, partId: '3', inline: true },
    ]);
  });

  it('keeps the legacy shape for attachments without size or partId', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [{ filename: 'f.bin', body: { attachmentId: 'a1' } }],
    };
    expect(parseMessage(msg(payload)).attachments).toEqual([
      { filename: 'f.bin', attachmentId: 'a1', mimeType: 'application/octet-stream' },
    ]);
  });
});
