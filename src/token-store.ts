import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, type CipherGCM } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ALIAS_RE, isReservedAlias } from './config-file.js';
import { getAccountSet } from './accounts.js';
import { noteSuccessfulDecrypt, resolveMasterKeyForDispatch } from './master-key.js';
import { atomicWriteFileSync, withFileLock } from './fs-atomic.js';
import type { TokenData } from './types.js';
import { assertKeysLive, base64KeyBytes, isEmptyKey, KeyMemo, markKeysDisposed, wipeBytes, type KeyMaterial } from './key-material.js';

export type { KeyMaterial };

const ENC_VERSION = 1;
// v2 = tenant-keyed: same GCM envelope, key = HKDF(deriveKey(masterKey), tenantId).
const ENC_VERSION_TENANT = 2;
const ALGO = 'aes-256-gcm';
// Namespaced HKDF info: a tenant id can never collide with another derivation
// purpose sharing the master key.
const HKDF_INFO_PREFIX = 'mcp-google-multi:token:v1:';

interface EncFile {
  v: number;
  iv: string;
  tag: string;
  data: string;
}

// KDF is COMPAT-FROZEN (changing it would brick every existing token); see docs/internals.md.
// A Buffer key is the UTF-8 bytes of the same key text and derives the same
// key as the equal string. The returned Buffer is fresh: the caller owns it
// and may wipe it.
export function deriveKey(masterKey: KeyMaterial): Buffer {
  assertKeysLive(undefined, masterKey);
  if (isEmptyKey(masterKey)) {
    throw new Error(
      'MASTER_KEY is required to encrypt/decrypt tokens. Generate one with: openssl rand -base64 32',
    );
  }
  const raw = base64KeyBytes(masterKey);
  if (raw) return raw;
  // Line kept as it was before Buffer keys: the CodeQL dismissal of this frozen
  // branch is tied to it. A Buffer ignores the encoding argument.
  return createHash('sha256').update(masterKey as string, 'utf8').digest();
}

// Per-(masterKey, tenantId) subkey memo, matched on both so a key rotation can
// never hit a stale subkey.
const tenantKeyMemo = new KeyMemo();

export function deriveTenantKey(masterKey: KeyMaterial, tenantId: string): Buffer {
  assertKeysLive(undefined, masterKey);
  const hit = tenantKeyMemo.get(masterKey, tenantId);
  if (hit) return hit;
  const ikm = deriveKey(masterKey);
  let subkey: Buffer;
  try {
    subkey = Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), `${HKDF_INFO_PREFIX}${tenantId}`, 32));
  } finally {
    wipeBytes(ikm);
  }
  tenantKeyMemo.set(masterKey, subkey, tenantId);
  return subkey;
}

/** Overwrite and drop every memoized tenant subkey (shutdown). A key handed
 * out earlier by deriveTenantKey is overwritten too. */
export function wipeTenantKeyMemo(): void {
  tenantKeyMemo.wipe();
  markKeysDisposed();
}

export function encryptToken(data: object, masterKey: KeyMaterial, tenantId?: string): string {
  assertKeysLive(undefined, masterKey);
  // v1 derives a fresh key per call, so it is ours to wipe; a tenant subkey is memoized.
  const key = tenantId === undefined ? deriveKey(masterKey) : deriveTenantKey(masterKey, tenantId);
  const plain = Buffer.from(JSON.stringify(data), 'utf8');
  const iv = randomBytes(12);
  let cipher: CipherGCM;
  let ciphertext: Buffer;
  try {
    cipher = createCipheriv(ALGO, key, iv);
    ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  } finally {
    wipeBytes(plain);
    if (tenantId === undefined) wipeBytes(key);
  }
  const file: EncFile = {
    v: tenantId === undefined ? ENC_VERSION : ENC_VERSION_TENANT,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  };
  return JSON.stringify(file);
}

export function decryptToken(fileContents: string, masterKey: KeyMaterial, tenantId?: string): TokenData {
  const file = JSON.parse(fileContents) as EncFile;
  let key: Buffer;
  if (file.v === ENC_VERSION) {
    // Never from a tenant-scoped caller: a tenant read reaching a v1
    // (owner-keyed) file is a path-isolation bug, not a migration path.
    if (tenantId !== undefined) {
      throw new Error(`Unsupported token file version: ${file.v} (owner-keyed file read with a tenant id)`);
    }
    key = deriveKey(masterKey);
  } else if (file.v === ENC_VERSION_TENANT) {
    if (tenantId === undefined) {
      throw new Error(`Unsupported token file version: ${file.v} (tenant-keyed file requires its tenant id)`);
    }
    key = deriveTenantKey(masterKey, tenantId);
  } else {
    throw new Error(`Unsupported token file version: ${file.v}`);
  }
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv(ALGO, key, Buffer.from(file.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(file.data, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8')) as TokenData;
  } finally {
    if (plaintext) wipeBytes(plaintext);
    if (file.v === ENC_VERSION) wipeBytes(key);
  }
}

function masterKey(): Buffer {
  return resolveMasterKeyForDispatch().bytes;
}

function encPath(alias: string): string {
  return getAccountSet().configs[alias].encPath;
}

export function readToken(alias: string): TokenData | null {
  let contents: string;
  try {
    contents = fs.readFileSync(encPath(alias), 'utf8');
  } catch {
    return null;
  }
  const data = decryptToken(contents, masterKey());
  noteSuccessfulDecrypt();
  return data;
}

// Lock + atomic-write mechanics live in fs-atomic.ts (generalized path-keyed
// from this file's original alias-keyed implementation; behavior unchanged).
export function writeToken(alias: string, data: object): void {
  withFileLock(encPath(alias), () => writeTokenAtomic(alias, data), `token lock: ${alias}`);
}

function writeTokenAtomic(alias: string, data: object): void {
  atomicWriteFileSync(encPath(alias), encryptToken(data, masterKey()), 0o600);
}

export function updateToken(alias: string, updates: object): void {
  withFileLock(
    encPath(alias),
    () => {
      // A refresh racing a token removal (revoked linked account) must never
      // resurrect the file; initial sign-in writes via writeToken.
      const existing = readToken(alias);
      if (existing === null) return;
      const definedUpdates = Object.fromEntries(
        Object.entries(updates).filter(([, value]) => value !== null && value !== undefined),
      );
      writeTokenAtomic(alias, { ...existing, ...definedUpdates });
    },
    `token lock: ${alias}`,
  );
}

export function hasToken(alias: string): boolean {
  return fs.existsSync(encPath(alias));
}

export interface TokenStore {
  readToken(alias: string): TokenData | null;
  writeToken(alias: string, data: object): void;
  updateToken(alias: string, updates: object): void;
  hasToken(alias: string): boolean;
}

/**
 * Context-scoped token store: `.enc` files live under `dir`, ciphertext keyed
 * by `tenantId` when present (HKDF v2 envelope; omitted = the single-owner v1
 * envelope). Same lock + atomic-write + error contract as the module-level
 * functions: readToken returns null ONLY when the file is missing and throws
 * on a decrypt failure.
 */
export function createTokenStore(dir: string, opts: { tenantId?: string; resolveKey?: () => KeyMaterial } = {}): TokenStore {
  const key = opts.resolveKey ?? masterKey;
  const tenantId = opts.tenantId;
  const encPathFor = (alias: string): string => {
    // The alias becomes a path segment: same traversal guard as the registry.
    if (!ALIAS_RE.test(alias) || isReservedAlias(alias)) {
      throw new Error(`Invalid alias "${alias}". Allowed characters: letters, digits, underscore, hyphen.`);
    }
    return path.join(dir, `${alias}.enc`);
  };
  const read = (alias: string): TokenData | null => {
    // Path guard OUTSIDE the missing-file catch: an invalid alias must throw,
    // never read as "no token".
    const encFile = encPathFor(alias);
    let contents: string;
    try {
      contents = fs.readFileSync(encFile, 'utf8');
    } catch {
      return null;
    }
    const data = decryptToken(contents, key(), tenantId);
    noteSuccessfulDecrypt();
    return data;
  };
  const writeAtomic = (alias: string, data: object): void => {
    atomicWriteFileSync(encPathFor(alias), encryptToken(data, key(), tenantId), 0o600);
  };
  return {
    readToken: read,
    writeToken: (alias, data) => {
      withFileLock(encPathFor(alias), () => writeAtomic(alias, data), `token lock: ${alias}`);
    },
    updateToken: (alias, updates) => {
      withFileLock(
        encPathFor(alias),
        () => {
          // A refresh racing a token removal (revoked linked account) must
          // never resurrect the file; initial sign-in writes via writeToken.
          const existing = read(alias);
          if (existing === null) return;
          const definedUpdates = Object.fromEntries(
            Object.entries(updates).filter(([, value]) => value !== null && value !== undefined),
          );
          writeAtomic(alias, { ...existing, ...definedUpdates });
        },
        `token lock: ${alias}`,
      );
    },
    hasToken: (alias) => fs.existsSync(encPathFor(alias)),
  };
}
