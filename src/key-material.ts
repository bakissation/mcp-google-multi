import { randomFillSync, timingSafeEqual } from 'node:crypto';

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

function keyBytes(key: KeyMaterial): Buffer {
  return typeof key === 'string' ? Buffer.from(key, 'utf8') : Buffer.from(key);
}

/** Memo of derived values per (key, sub id). A hit is found by comparing the
 * key bytes, not by hashing the key text into a lookup string. The entries
 * hold a private copy of the key bytes and the derived value; wipe() overwrites
 * both. */
export class KeyMemo {
  private readonly slots = new Map<string, Array<{ key: Buffer; value: Buffer }>>();

  get(key: KeyMaterial, sub = ''): Buffer | undefined {
    const entries = this.slots.get(sub);
    if (!entries) return undefined;
    const probe = keyBytes(key);
    try {
      return entries.find((e) => e.key.length === probe.length && timingSafeEqual(e.key, probe))?.value;
    } finally {
      wipeBytes(probe);
    }
  }

  set(key: KeyMaterial, value: Buffer, sub = ''): void {
    const entries = this.slots.get(sub) ?? [];
    entries.push({ key: keyBytes(key), value });
    this.slots.set(sub, entries);
  }

  /** Overwrite every held key copy and value, then drop them. */
  wipe(): void {
    for (const entries of this.slots.values()) {
      for (const e of entries) {
        wipeBytes(e.key);
        wipeBytes(e.value);
      }
    }
    this.slots.clear();
  }
}
