import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACCOUNT_CONFIG } from '../src/accounts.js';
import { deriveKey, encryptToken, decryptToken, readToken, writeToken, updateToken } from '../src/token-store.js';

const KEY = 'test-master-key';
const sample = { refresh_token: 'r', access_token: 'a', scope: 's', expiry_date: 123 };

const originalPath = ACCOUNT_CONFIG.test.encPath;
const cleanupDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  ACCOUNT_CONFIG.test.encPath = originalPath;
  delete process.env.MASTER_KEY;
  for (const dir of cleanupDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('token-store crypto', () => {
  it('round-trips a token object', () => {
    expect(decryptToken(encryptToken(sample, KEY), KEY)).toEqual(sample);
  });

  it('never leaks plaintext into the encrypted file', () => {
    const enc = encryptToken(sample, KEY);
    expect(enc).not.toContain('refresh_token');
    expect(enc).not.toContain('"r"');
    const o = JSON.parse(enc);
    expect(o).toMatchObject({ v: 1 });
    expect(o.iv && o.tag && o.data).toBeTruthy();
  });

  it('uses a fresh IV per call (ciphertext differs each time)', () => {
    expect(encryptToken(sample, KEY)).not.toBe(encryptToken(sample, KEY));
  });

  it('fails to decrypt with the wrong key', () => {
    expect(() => decryptToken(encryptToken(sample, KEY), 'wrong-key')).toThrow();
  });

  it('fails on tampered ciphertext (GCM auth)', () => {
    const o = JSON.parse(encryptToken(sample, KEY));
    const buf = Buffer.from(o.data, 'base64');
    buf[0] ^= 0xff;
    o.data = buf.toString('base64');
    expect(() => decryptToken(JSON.stringify(o), KEY)).toThrow();
  });

  it('rejects an unsupported file version', () => {
    const o = JSON.parse(encryptToken(sample, KEY));
    o.v = 99;
    expect(() => decryptToken(JSON.stringify(o), KEY)).toThrow(/version/i);
  });

  it('throws a clear error when MASTER_KEY is empty', () => {
    expect(() => deriveKey('')).toThrow(/MASTER_KEY/);
  });

  it('accepts a base64 32-byte key directly', () => {
    const k = Buffer.alloc(32, 7).toString('base64');
    expect(deriveKey(k)).toHaveLength(32);
    expect(decryptToken(encryptToken(sample, k), k)).toEqual(sample);
  });

  it('derives a 32-byte key from an arbitrary passphrase', () => {
    expect(deriveKey('short')).toHaveLength(32);
  });

  it('keeps the previous token readable when a replacement write fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-store-'));
    cleanupDirs.push(dir);
    ACCOUNT_CONFIG.test.encPath = path.join(dir, 'test.enc');
    process.env.MASTER_KEY = KEY;
    writeToken('test', sample);

    const originalWrite = fs.writeFileSync.bind(fs);
    let interrupted = false;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (typeof file === 'number' || interrupted) return originalWrite(file, data, options);
      interrupted = true;
      originalWrite(file, String(data).slice(0, 12), options);
      throw new Error('simulated interrupted write');
    });

    expect(() => writeToken('test', { ...sample, access_token: 'new' })).toThrow(/interrupted/);
    expect(interrupted).toBe(true);
    expect(readToken('test')).toEqual(sample);
  });

  it('recovers a token lock left by a dead process', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-store-'));
    cleanupDirs.push(dir);
    ACCOUNT_CONFIG.test.encPath = path.join(dir, 'test.enc');
    process.env.MASTER_KEY = KEY;
    fs.writeFileSync(path.join(dir, '.test.enc.lock'), '2147483647', { mode: 0o600 });

    writeToken('test', sample);

    expect(readToken('test')).toEqual(sample);
  });

  it('recovers a token lock containing non-PID garbage', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-store-'));
    cleanupDirs.push(dir);
    ACCOUNT_CONFIG.test.encPath = path.join(dir, 'test.enc');
    process.env.MASTER_KEY = KEY;
    fs.writeFileSync(path.join(dir, '.test.enc.lock'), 'not-a-pid', { mode: 0o600 });

    writeToken('test', sample);

    expect(readToken('test')).toEqual(sample);
  });

  it('treats an unsignalable lock owner (EPERM) as alive and times out', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-store-'));
    cleanupDirs.push(dir);
    ACCOUNT_CONFIG.test.encPath = path.join(dir, 'test.enc');
    process.env.MASTER_KEY = KEY;
    const lock = path.join(dir, '.test.enc.lock');
    fs.writeFileSync(lock, '12345', { mode: 0o600 });

    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 6_000));

    expect(() => writeToken('test', sample)).toThrow(/Timed out waiting for token lock/);
    expect(fs.readFileSync(lock, 'utf8')).toBe('12345');
  });

  it('retries the token rename through transient sharing violations', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-store-'));
    cleanupDirs.push(dir);
    ACCOUNT_CONFIG.test.encPath = path.join(dir, 'test.enc');
    process.env.MASTER_KEY = KEY;

    const originalRename = fs.renameSync.bind(fs);
    let failures = 0;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (failures < 2) {
        failures++;
        const err = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return originalRename(from, to);
    });

    writeToken('test', sample);

    expect(spy).toHaveBeenCalledTimes(3);
    expect(readToken('test')).toEqual(sample);
  });

  it('gives up on the rename after bounded attempts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-store-'));
    cleanupDirs.push(dir);
    ACCOUNT_CONFIG.test.encPath = path.join(dir, 'test.enc');
    process.env.MASTER_KEY = KEY;

    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      const err = new Error('EBUSY: resource busy or locked, rename') as NodeJS.ErrnoException;
      err.code = 'EBUSY';
      throw err;
    });

    expect(() => writeToken('test', sample)).toThrow(/EBUSY/);
    expect(spy).toHaveBeenCalledTimes(5);
    expect(readToken('test')).toBeNull();
  });

  it('does not retry the rename on non-transient errors', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-store-'));
    cleanupDirs.push(dir);
    ACCOUNT_CONFIG.test.encPath = path.join(dir, 'test.enc');
    process.env.MASTER_KEY = KEY;

    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      const err = new Error('ENOENT: no such file or directory, rename') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    expect(() => writeToken('test', sample)).toThrow(/ENOENT/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not let tmp cleanup failures mask the rename error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-store-'));
    cleanupDirs.push(dir);
    ACCOUNT_CONFIG.test.encPath = path.join(dir, 'test.enc');
    process.env.MASTER_KEY = KEY;

    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      const err = new Error('EBUSY: resource busy or locked, rename') as NodeJS.ErrnoException;
      err.code = 'EBUSY';
      throw err;
    });
    const originalRm = fs.rmSync.bind(fs);
    vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target).endsWith('.tmp')) {
        const err = new Error('EPERM: operation not permitted, unlink') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return originalRm(target, options);
    });

    expect(() => writeToken('test', sample)).toThrow(/EBUSY/);
  });

  it('merges refresh updates with the latest token inside the store boundary', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-store-'));
    cleanupDirs.push(dir);
    ACCOUNT_CONFIG.test.encPath = path.join(dir, 'test.enc');
    process.env.MASTER_KEY = KEY;
    writeToken('test', sample);

    updateToken('test', { access_token: 'new', refresh_token: null, expiry_date: 456 });

    expect(readToken('test')).toEqual({ ...sample, access_token: 'new', expiry_date: 456 });
  });
});
