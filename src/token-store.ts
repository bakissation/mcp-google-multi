import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { getAccountSet } from './accounts.js';
import { atomicWriteFileSync, withFileLock } from './fs-atomic.js';
import type { TokenData } from './types.js';

const ENC_VERSION = 1;
const ALGO = 'aes-256-gcm';

interface EncFile {
  v: number;
  iv: string;
  tag: string;
  data: string;
}

export function deriveKey(masterKey: string): Buffer {
  if (!masterKey) {
    throw new Error(
      'MASTER_KEY is required to encrypt/decrypt tokens. Generate one with: openssl rand -base64 32',
    );
  }
  const raw = Buffer.from(masterKey, 'base64');
  if (raw.length === 32) return raw;
  return createHash('sha256').update(masterKey, 'utf8').digest();
}

export function encryptToken(data: object, masterKey: string): string {
  const key = deriveKey(masterKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(data), 'utf8')),
    cipher.final(),
  ]);
  const file: EncFile = {
    v: ENC_VERSION,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  };
  return JSON.stringify(file);
}

export function decryptToken(fileContents: string, masterKey: string): TokenData {
  const key = deriveKey(masterKey);
  const file = JSON.parse(fileContents) as EncFile;
  if (file.v !== ENC_VERSION) {
    throw new Error(`Unsupported token file version: ${file.v}`);
  }
  const decipher = createDecipheriv(ALGO, key, Buffer.from(file.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(file.data, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8')) as TokenData;
}

function masterKey(): string {
  return process.env.MASTER_KEY ?? '';
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
  return decryptToken(contents, masterKey());
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
      const existing = readToken(alias) ?? {};
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
