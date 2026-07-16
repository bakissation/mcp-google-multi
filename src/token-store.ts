import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ACCOUNT_CONFIG } from './accounts.js';
import type { TokenData } from './types.js';

const ENC_VERSION = 1;
const ALGO = 'aes-256-gcm';
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;

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

export function readToken(alias: string): TokenData | null {
  let contents: string;
  try {
    contents = fs.readFileSync(ACCOUNT_CONFIG[alias].encPath, 'utf8');
  } catch {
    return null;
  }
  return decryptToken(contents, masterKey());
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withTokenLock<T>(alias: string, fn: () => T): T {
  const p = ACCOUNT_CONFIG[alias].encPath;
  const dir = path.dirname(p);
  const lock = path.join(dir, `.${path.basename(p)}.lock`);
  const ownerFile = `${lock}.${process.pid}.${randomBytes(6).toString('hex')}.owner`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ownerFile, String(process.pid), { mode: 0o600, flag: 'wx' });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  try {
    while (true) {
      try {
        fs.linkSync(ownerFile, lock);
        break;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'EEXIST') throw error;
        try {
          const observedOwner = fs.readFileSync(lock, 'utf8');
          const owner = Number(observedOwner);
          // Non-PID content can only come from a corrupt or interrupted lock
          // write — recover it like a dead owner instead of spinning to timeout.
          let ownerDead = !(Number.isSafeInteger(owner) && owner > 0);
          if (!ownerDead) {
            try {
              process.kill(owner, 0);
            } catch (ownerError) {
              const code = (ownerError as NodeJS.ErrnoException).code;
              // EPERM: the PID exists but is not signalable (recycled by another
              // user) — treat as alive and wait out the timeout rather than
              // break a lock we cannot verify.
              if (code === 'ESRCH') ownerDead = true;
              else if (code !== 'EPERM') throw ownerError;
            }
          }
          if (ownerDead) {
            if (fs.readFileSync(lock, 'utf8') === observedOwner) fs.rmSync(lock, { force: true });
            continue;
          }
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === 'ENOENT') {
            continue;
          }
          throw readError;
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for token lock: ${alias}`, { cause: error });
        }
        sleep(LOCK_RETRY_MS);
      }
    }
  } finally {
    fs.rmSync(ownerFile, { force: true });
  }

  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

function writeTokenAtomic(alias: string, data: object): void {
  const p = ACCOUNT_CONFIG[alias].encPath;
  const dir = path.dirname(p);
  const tmp = path.join(dir, `.${path.basename(p)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, encryptToken(data, masterKey()), { mode: 0o600, flag: 'wx' });
    const fd = fs.openSync(tmp, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, p);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function writeToken(alias: string, data: object): void {
  withTokenLock(alias, () => writeTokenAtomic(alias, data));
}

export function updateToken(alias: string, updates: object): void {
  withTokenLock(alias, () => {
    const existing = readToken(alias) ?? {};
    const definedUpdates = Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== null && value !== undefined),
    );
    writeTokenAtomic(alias, { ...existing, ...definedUpdates });
  });
}

export function hasToken(alias: string): boolean {
  return fs.existsSync(ACCOUNT_CONFIG[alias].encPath);
}
