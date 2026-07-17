import { randomBytes } from 'node:crypto';

/**
 * RFC 2047 encoded-word (`=?utf-8?B?...?=`) for non-ASCII header text.
 * Long values are split into multiple <=75-char encoded-words separated
 * by `\r\n ` (CRLF SPACE) per the RFC's folding rule.
 */
export function encodeHeaderValue(value: string): string {
  // Span includes control chars on purpose — testing for "is this entire
  // string ASCII?", not "is it printable?".
  // eslint-disable-next-line no-control-regex
  if (value === '' || /^[\x00-\x7F]*$/.test(value)) return value;
  const prefix = '=?utf-8?B?';
  const suffix = '?=';
  const maxInner = 75 - prefix.length - suffix.length;
  // base64 emits 4 output chars per 3 input bytes (always padded to a
  // multiple of 4). Round maxInner DOWN to a multiple of 4 first.
  const maxBytesPerChunk = Math.floor(maxInner / 4) * 3;

  // Iterate by codepoint so each chunk's bytes form a complete UTF-8
  // sequence — many MUAs decode encoded-words individually before joining,
  // so a mid-byte split would surface as U+FFFD in those clients.
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

/**
 * Encode an address-list header (To/Cc/Bcc/From). RFC 2047 forbids
 * encoded-words inside the addr-spec, so only the display name is encoded.
 */
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

/**
 * RFC 5322 §2.3: CR and LF MUST only occur together as CRLF in bodies.
 * Normalize bare `\n` or `\r` to CRLF.
 */
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

/**
 * Best-effort HTML→plain-text for reading HTML-only emails. Regex-based on
 * purpose — no HTML parser dependency, and mail HTML is flat enough for it.
 */
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

/**
 * RFC 5322 threading: In-Reply-To/References must carry the parent's real
 * Message-ID header, not the Gmail API id. Falls back to the API id when the
 * header is missing so replies still thread inside Gmail.
 */
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

/**
 * RFC 2046 §5.1.1 boundary token: 1-70 chars from a restricted set, no trailing space.
 * randomBytes hex output is only [0-9a-f], all of which are bcharsnospace.
 */
function generateMimeBoundary(): string {
  // 5-char prefix + 32 hex chars = 37 chars, well under the 70-char limit.
  return `=_gm_${randomBytes(16).toString('hex')}`;
}

/**
 * Build a multipart/alternative body so HTML-capable clients render the rich
 * version and plain clients fall back. Returns the header value AND the body.
 * Caller composes the full message: headers (including this Content-Type) + CRLF + body.
 */
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
