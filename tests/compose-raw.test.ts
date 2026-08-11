import { describe, it, expect } from 'vitest';
import {
  composeRaw,
  encodeAddressHeader,
  encodeHeaderValue,
  buildMultipartAlternative,
  normalizeBodyLineEndings,
} from '../src/tools/gmail-mime.js';

// Oracle: the EXACT pre-A3 inline assembly (copied verbatim from gmail.ts
// gmail_send/gmail_create_draft before the composeRaw extraction). A3 must be
// byte-identical to this.
function legacyCompose(o: {
  from: string; to: string; subject: string; text: string;
  html?: string; cc?: string; inReplyTo?: string; references?: string;
}): string {
  const headers = [
    `From: ${encodeAddressHeader(o.from)}`,
    `To: ${encodeAddressHeader(o.to)}`,
    `Subject: ${encodeHeaderValue(o.subject)}`,
    'MIME-Version: 1.0',
  ];
  let bodyText: string;
  if (o.html) {
    const { contentType, body: mp } = buildMultipartAlternative(o.text, o.html);
    headers.push(`Content-Type: ${contentType}`);
    bodyText = mp;
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    headers.push('Content-Transfer-Encoding: 8bit');
    bodyText = normalizeBodyLineEndings(o.text);
  }
  if (o.cc) headers.push(`Cc: ${encodeAddressHeader(o.cc)}`);
  if (o.inReplyTo !== undefined && o.references !== undefined) {
    headers.push(`In-Reply-To: ${o.inReplyTo}`);
    headers.push(`References: ${o.references}`);
  }
  return Buffer.from([...headers, '', bodyText].join('\r\n'), 'utf-8').toString('base64url');
}

// buildMultipartAlternative uses a random boundary, so for the html cases we
// compare the DECODED structure minus the boundary token rather than base64.
function decodeStable(b64: string): string {
  return Buffer.from(b64, 'base64url').toString('utf-8').replace(/=_gm_[0-9a-f]{32}/g, '=_gm_BOUNDARY');
}

const CASES = [
  { name: 'plain only', from: 'me@x.com', to: 'a@y.com', subject: 'Hello', text: 'Line1\nLine2' },
  { name: 'non-ascii subject', from: 'me@x.com', to: 'a@y.com', subject: 'Réunion café ☕', text: 'body' },
  { name: 'with cc', from: 'me@x.com', to: 'a@y.com', subject: 'S', text: 'b', cc: 'c@z.com, d@z.com' },
  { name: 'reply headers', from: 'me@x.com', to: 'a@y.com', subject: 'Re: x', text: 'b', inReplyTo: '<abc@mail>', references: '<r1@mail> <abc@mail>' },
  { name: 'display-name address', from: '"Me Myself" <me@x.com>', to: 'Aya <a@y.com>', subject: 'S', text: 'b' },
  { name: 'crlf-mixed body', from: 'me@x.com', to: 'a@y.com', subject: 'S', text: 'a\nb\r\nc\rd' },
];

describe('composeRaw golden matrix (A3 byte-identical to legacy)', () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(composeRaw(c)).toBe(legacyCompose(c));
    });
  }

  it('plain+htmlBody: identical modulo the random MIME boundary', () => {
    const c = { from: 'me@x.com', to: 'a@y.com', subject: 'S', text: 'plain', html: '<p>rich</p>' };
    expect(decodeStable(composeRaw(c))).toBe(decodeStable(legacyCompose(c)));
  });

  it('reply headers only apply when BOTH inReplyTo and references are present', () => {
    const c = { from: 'm@x', to: 'a@y', subject: 'S', text: 'b', inReplyTo: '<only@id>' };
    expect(Buffer.from(composeRaw(c), 'base64url').toString()).not.toContain('In-Reply-To');
  });
});
