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

/**
 * RFC 2046 §5.1.1 boundary token: 1-70 chars from a restricted set, no trailing space.
 * Hex output from randomBytes only emits [0-9a-f], all of which are bcharsnospace.
 */
function generateMimeBoundary(): string {
  // 32 hex chars + 16-char prefix = 48 chars, well under the 70-char limit.
  const rand = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join('');
  return `=_gm_${rand}${Date.now().toString(36)}`;
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
