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
 * A fresh Buffer the caller owns. A Buffer is decoded to the string it is the
 * UTF-8 of first, so it takes the same branch as the equal string. Reading it
 * as latin1 instead would differ for a character above U+00FF: Node's base64
 * decoder looks at that character's low UTF-16 byte, not at its UTF-8 bytes. */
export function base64KeyBytes(key: KeyMaterial): Buffer | null {
  const raw = Buffer.from(typeof key === 'string' ? key : key.toString('utf8'), 'base64');
  if (raw.length === 32) return raw;
  wipeBytes(raw);
  return null;
}

// Set by the wipe functions. Wiped key bytes are random, not absent, so a write
// that used them would succeed and produce data nothing can decrypt. Once any
// wipe ran, key derivation and encryption throw until a fresh resolve of the
// master or JWT key re-arms them. A holder built before a wipe (RefreshStore,
// the family tagger) also throws for good, through the epoch it captured.
let disposed = false;
let wipeEpoch = 0;

export function markKeysDisposed(): void {
  disposed = true;
  wipeEpoch += 1;
}

export function markKeysLive(): void {
  disposed = false;
}

export function keysEpoch(): number {
  return wipeEpoch;
}

export function assertKeysLive(epoch?: number): void {
  if (disposed || (epoch !== undefined && epoch !== wipeEpoch)) {
    throw new Error('E_KEYS_WIPED: the key material was wiped at shutdown; nothing may derive, encrypt or sign with it');
  }
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

  /** Overwrite every held key copy and value, then drop them. Not a disposal
   * by itself: the wipe functions that own a memo also call markKeysDisposed. */
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
