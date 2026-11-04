import { createHmac, randomBytes, randomFillSync } from 'node:crypto';

/**
 * Key text as the operator provisions it: the base64 of 32 random bytes, or a
 * passphrase. A Buffer holds the UTF-8 bytes of that same text, so a string
 * and a Buffer of equal content always derive the same keys.
 */
export type KeyMaterial = string | Buffer;

/** Overwrite with random bytes, not zeros: a use after the wipe then fails
 * closed instead of running on a publicly known all-zero key. */
export function wipeBytes(bytes: Uint8Array): void {
  randomFillSync(bytes);
}

export function isEmptyKey(key: KeyMaterial | undefined | null): boolean {
  return !key || key.length === 0;
}

/** The decoded 32 bytes when `key` is base64 of exactly 32 bytes, else null.
 * A fresh Buffer the caller owns. A Buffer input is read as latin1 so the
 * decode sees one character per byte; bytes above 0x7f are not base64 either
 * way, so the result equals the string form's. */
export function base64KeyBytes(key: KeyMaterial): Buffer | null {
  const raw = Buffer.from(typeof key === 'string' ? key : key.toString('latin1'), 'base64');
  if (raw.length === 32) return raw;
  wipeBytes(raw);
  return null;
}

// Per-process: a fingerprint is only ever compared inside this process, and a
// keyed hash is not a bare hash of the key text.
const FINGERPRINT_SALT = randomBytes(32);

/** Memo-map key for a key: lets a cache be keyed on a key without holding the
 * key text itself as a Map key. Equal text gives an equal fingerprint within
 * one process; it means nothing outside it. */
export function keyFingerprint(key: KeyMaterial): string {
  return createHmac('sha256', FINGERPRINT_SALT).update(key).digest('hex');
}
