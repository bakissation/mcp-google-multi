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
