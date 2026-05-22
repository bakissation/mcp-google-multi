import { describe, it, expect } from 'vitest';
import { deriveKey, encryptToken, decryptToken } from '../src/token-store.js';

const KEY = 'test-master-key';
const sample = { refresh_token: 'r', access_token: 'a', scope: 's', expiry_date: 123 };

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
});
