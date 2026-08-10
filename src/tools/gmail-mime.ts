import { randomBytes } from 'node:crypto';

/** RFC 2047 encoded-word (`=?utf-8?B?...?=`) for non-ASCII header text; long values fold into <=75-char chunks joined by CRLF SPACE per the RFC. */
export function encodeHeaderValue(value: string): string {
  // Control chars in the span are intentional: testing "entirely ASCII", not "printable".
  // eslint-disable-next-line no-control-regex
  if (value === '' || /^[\x00-\x7F]*$/.test(value)) return value;
  const prefix = '=?utf-8?B?';
  const suffix = '?=';
  const maxInner = 75 - prefix.length - suffix.length;
  // base64 emits 4 output chars per 3 input bytes (always padded to a
  // multiple of 4). Round maxInner DOWN to a multiple of 4 first.
  const maxBytesPerChunk = Math.floor(maxInner / 4) * 3;

  // Chunk on codepoint boundaries: many MUAs decode each encoded-word separately, so a mid-UTF-8-sequence split renders U+FFFD.
  const chunks: string[] = [];
  let buffered: number[] = [];
  for (const char of value) {
    const charBytes = Array.from(Buffer.from(char, 'utf-8'));
    if (buffered.length + charBytes.length > maxBytesPerChunk && buffered.length > 0) {
      chunks.push(`${prefix}${Buffer.from(buffered).toString('base64')}${suffix}`);
      buffered = [];
    }
    buffered.push(...charBytes);
  }
  if (buffered.length > 0) {
    chunks.push(`${prefix}${Buffer.from(buffered).toString('base64')}${suffix}`);
  }
  return chunks.join('\r\n ');
}

/** Address-list headers (To/Cc/Bcc/From): RFC 2047 forbids encoded-words in the addr-spec, so only display names are encoded. */
export function encodeAddressHeader(value: string): string {
  if (value === '') return '';
  return value.split(',').map((part) => {
    const trimmed = part.trim();
    if (trimmed === '') return '';
    const m = trimmed.match(/^(.*?)<([^>]+)>$/);
    if (m) {
      const rawName = m[1].trim().replace(/^"(.*)"$/, '$1').trim();
      const addr = m[2].trim();
      if (rawName === '') return `<${addr}>`;
      return `${encodeHeaderValue(rawName)} <${addr}>`;
    }
    return trimmed;
  }).filter(Boolean).join(', ');
}

/** RFC 5322 §2.3 forbids bare CR or LF in bodies; normalize everything to CRLF. */
export function normalizeBodyLineEndings(body: string): string {
  return body.replace(/\r\n|\r|\n/g, '\r\n');
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function codePointToChar(code: number, fallback: string): string {
  if (Number.isNaN(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return fallback;
  return String.fromCodePoint(code);
}

function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g,
    (match, dec, hex, named) => {
      if (dec) return codePointToChar(parseInt(dec, 10), match);
      if (hex) return codePointToChar(parseInt(hex, 16), match);
      return NAMED_ENTITIES[named.toLowerCase()] ?? match;
    },
  );
}

// Fixpoint tag strip: one pass can reassemble a tag from a removed span's
// edges (<scr<b>ipt> -> <script>).
function stripTags(input: string, replacement = ''): string {
  let out = input;
  for (let previous = ''; previous !== out; ) {
    previous = out;
    out = out.replace(/<[^>]*>/g, replacement);
  }
  return out;
}

/** Best-effort HTML→plain-text for HTML-only emails; regex on purpose (avoids an HTML-parser dep, mail HTML is flat enough). */
export function htmlToText(html: string): string {
  // Repeat until stable: single-pass removal can leave behind sequences
  // reassembled from the removed span's edges (<scr<script>ipt>).
  let text = html;
  for (let previous = ''; previous !== text; ) {
    previous = text;
    text = text
      // --!> is a valid comment terminator per WHATWG
      .replace(/<!--[\s\S]*?--!?>/g, '')
      // an unterminated comment consumes the rest of the document per spec
      .replace(/<!--[\s\S]*$/, '')
      .replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  }
  // All comment content is gone; drop any stray bare delimiters too.
  text = text.replace(/<!--|--!?>/g, '');
  // Source whitespace (incl. newlines) is insignificant in HTML; real line
  // structure is reintroduced from block tags below.
  text = text.replace(/\s+/g, ' ');

  text = text.replace(
    /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_match, dq, sq, inner) => {
      const href = (dq ?? sq ?? '').trim();
      const innerText = stripTags(inner, ' ').replace(/\s+/g, ' ').trim();
      const redundant =
        href === '' ||
        href.startsWith('#') ||
        href === innerText ||
        href === `mailto:${innerText}`;
      return redundant ? inner : `${inner} (${href})`;
    },
  );

  text = text
    .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<(?:p|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|h[1-6]|li|tr|table|ul|ol|blockquote|pre|section|article|header|footer|address|figure|dl|dt|dd)\s*>/gi, '\n');
  text = stripTags(text);

  return decodeEntities(text)
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** In-Reply-To/References need the parent's real RFC 5322 Message-ID header, not the Gmail API id;
 * falls back to the API id so replies still thread inside Gmail. */
export function buildReplyHeaders(
  fallbackId: string,
  parentMessageIdHeader: string,
  parentReferences: string,
): { inReplyTo: string; references: string } {
  const parentId = parentMessageIdHeader.trim();
  if (parentId === '') return { inReplyTo: fallbackId, references: fallbackId };
  const refs = parentReferences.trim().replace(/\s+/g, ' ');
  return {
    inReplyTo: parentId,
    references: refs === '' ? parentId : `${refs} ${parentId}`,
  };
}

/** RFC 2046 §5.1.1 boundary token: hex output is all bcharsnospace, length well under the 70-char cap. */
function generateMimeBoundary(): string {
  // 5-char prefix + 32 hex chars = 37 chars, well under the 70-char limit.
  return `=_gm_${randomBytes(16).toString('hex')}`;
}

/** multipart/alternative (plain fallback + HTML); caller composes the message: headers (incl. returned Content-Type) + CRLF + body. */
export function buildMultipartAlternative(
  plainBody: string,
  htmlBody: string,
): { contentType: string; body: string } {
  const boundary = generateMimeBoundary();
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    normalizeBodyLineEndings(plainBody),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    normalizeBodyLineEndings(htmlBody),
    `--${boundary}--`,
    '',
  ];
  return {
    contentType: `multipart/alternative; boundary="${boundary}"`,
    body: parts.join('\r\n'),
  };
}
