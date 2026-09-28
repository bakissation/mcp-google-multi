// Independent spec code for the r1 refresh-token format (docs/internals.md,
// "Refresh families count generations"). It never imports the store: a
// format slip there disagrees with this file instead of agreeing with itself,
// and a family at generation 5,000 is written directly instead of by 5,000
// fsynced rotations.
import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { decryptToken, deriveKey, encryptToken } from '../src/token-store.js';

export function specKey(masterKey: string): Buffer {
  return Buffer.from(hkdfSync('sha256', deriveKey(masterKey), Buffer.alloc(0), 'mcp-google-multi:refresh-mac:v1', 32));
}

export function specMac(masterKey: string, body: Buffer): Buffer {
  return createHmac('sha256', specKey(masterKey)).update(Buffer.concat([Buffer.from('mcp-google-multi refresh r1\n'), body])).digest();
}

export interface SpecToken {
  token: string;
  /** The store's `cur` for this token. */
  cur: string;
  /** The family's map key. */
  fid: string;
  bytes: Buffer;
}

export function specToken(masterKey: string, fid: Buffer, gen: number, opts: { rand?: Buffer; mac?: Buffer } = {}): SpecToken {
  const g = Buffer.alloc(4);
  g.writeUInt32BE(gen);
  const body = Buffer.concat([fid, g, opts.rand ?? randomBytes(16)]);
  const bytes = Buffer.concat([body, opts.mac ?? specMac(masterKey, body)]);
  return { token: `r1.${bytes.toString('base64url')}`, cur: createHash('sha256').update(bytes).digest('base64url'), fid: fid.toString('base64url'), bytes };
}

/** The decoded bytes of an r1 token. */
export const r1Bytes = (token: string): Buffer => Buffer.from(token.slice(3), 'base64url');

/** First 8 hex of sha256: a family id's bytes, or an earlier-release family id string. */
export const specTag = (family: Buffer | string): string => createHash('sha256').update(family).digest('hex').slice(0, 8);

/** A deterministic 43-character earlier-release token. */
export const legacyTok = (label: string): string => createHash('sha256').update(label).digest('base64url');

export interface StoreFile {
  format?: number;
  families: Record<string, { sub: string; gen: number; cur: string; createdAt: number; usedAt: number; legacy?: string }>;
  active: Record<string, { sub: string; issuedAt: number; family: string }>;
  spent: Record<string, string>;
}

export function seedFamilies(
  file: string,
  masterKey: string,
  families: Record<string, unknown>,
  legacy: { active?: Record<string, unknown>; spent?: Record<string, unknown> } = {},
): void {
  writeFileSync(file, encryptToken({ format: 2, families, active: legacy.active ?? {}, spent: legacy.spent ?? {} }, masterKey), { mode: 0o600 });
}

/** A file as an earlier release wrote it: no `format`, no `families`. */
export function seedLegacy(file: string, masterKey: string, active: Record<string, unknown>, spent: Record<string, unknown> = {}): void {
  writeFileSync(file, encryptToken({ active, spent }, masterKey), { mode: 0o600 });
}

export const onDisk = (file: string, masterKey: string): StoreFile => decryptToken(readFileSync(file, 'utf-8'), masterKey) as unknown as StoreFile;
