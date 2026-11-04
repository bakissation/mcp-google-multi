import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { base64KeyBytes, keyFingerprint, wipeBytes } from '../src/key-material.js';
import { decryptToken, deriveKey, deriveTenantKey, encryptToken, createTokenStore, wipeTenantKeyMemo } from '../src/token-store.js';
import { RefreshStore, jwtSecretFrom, refreshFamilyTagger, refreshMacKey, wipeRefreshKeyMemo } from '../src/mcp-token.js';
import {
  clearKeyCacheForTest,
  deleteMasterKeyMaterial,
  peekMasterKeyProvenance,
  resolveJwtKey,
  resolveMasterKey,
  setScrubKeyEnv,
  wipeKeyCache,
} from '../src/master-key.js';

const B64_KEY = randomBytes(32).toString('base64');
const PASSPHRASE = 'correct horse battery staple';
const sample = { refresh_token: 'r', access_token: 'a', scope: 's', expiry_date: 123 };
const buf = (s: string): Buffer => Buffer.from(s, 'utf8');
const allZero = (b: Uint8Array): boolean => b.every((x) => x === 0);

let dir: string;
beforeEach(() => {
  clearKeyCacheForTest();
  dir = mkdtempSync(path.join(tmpdir(), 'bufkeys-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MASTER_KEY;
  delete process.env.MCP_JWT_KEY;
  clearKeyCacheForTest();
});

describe('key-material', () => {
  it('wipeBytes overwrites with random bytes, not zeros', () => {
    const b = Buffer.alloc(32);
    wipeBytes(b);
    expect(allZero(b)).toBe(false);
    const c = Buffer.alloc(0);
    expect(() => wipeBytes(c)).not.toThrow();
  });

  it('base64KeyBytes returns the 32 decoded bytes or null, for both forms', () => {
    expect(base64KeyBytes(B64_KEY)?.toString('base64')).toBe(B64_KEY);
    expect(base64KeyBytes(buf(B64_KEY))?.toString('base64')).toBe(B64_KEY);
    expect(base64KeyBytes(PASSPHRASE)).toBeNull();
    expect(base64KeyBytes(buf(PASSPHRASE))).toBeNull();
  });

  it('keyFingerprint is equal for equal text and differs otherwise', () => {
    expect(keyFingerprint(PASSPHRASE)).toBe(keyFingerprint(buf(PASSPHRASE)));
    expect(keyFingerprint(PASSPHRASE)).not.toBe(keyFingerprint(`${PASSPHRASE}x`));
    expect(keyFingerprint(PASSPHRASE)).not.toContain('correct');
  });
});

describe('deriveKey: a Buffer derives what the equal string derives', () => {
  const cases: [string, string][] = [
    ['base64 of 32 bytes', B64_KEY],
    ['passphrase', PASSPHRASE],
    ['url-safe base64 of 32 bytes', B64_KEY.replace(/\+/g, '-').replace(/\//g, '_')],
    ['32-byte base64 with a line break inside', `${B64_KEY.slice(0, 20)}\n${B64_KEY.slice(20)}`],
    ['non-ASCII passphrase', 'pässwörd-日本語-🔑'],
    ['base64 of 33 bytes', randomBytes(33).toString('base64')],
    ['base64 of 31 bytes', randomBytes(31).toString('base64')],
    ['43 chars, no padding', B64_KEY.replace(/=+$/, '')],
  ];
  for (const [name, text] of cases) {
    it(name, () => {
      expect(deriveKey(buf(text)).equals(deriveKey(text))).toBe(true);
      expect(deriveTenantKey(buf(text), 't1').equals(deriveTenantKey(text, 't1'))).toBe(true);
      expect(refreshMacKey(buf(text)).equals(refreshMacKey(text))).toBe(true);
    });
  }

  it('agrees on random keys of random shapes', () => {
    for (let i = 0; i < 200; i++) {
      const text = i % 2 === 0 ? randomBytes(24 + (i % 24)).toString(i % 4 === 0 ? 'base64' : 'base64url') : randomBytes(8 + (i % 40)).toString('latin1');
      expect(deriveKey(buf(text)).equals(deriveKey(text))).toBe(true);
    }
  });

  it('refuses an empty key in both forms', () => {
    expect(() => deriveKey('')).toThrow(/MASTER_KEY is required/);
    expect(() => deriveKey(Buffer.alloc(0))).toThrow(/MASTER_KEY is required/);
    expect(() => refreshMacKey(Buffer.alloc(0))).toThrow(/MASTER_KEY is required/);
  });

  it('returns a fresh Buffer and leaves the input untouched', () => {
    const input = buf(B64_KEY);
    const before = Buffer.from(input);
    const a = deriveKey(input);
    wipeBytes(a);
    expect(input.equals(before)).toBe(true);
    expect(deriveKey(input).equals(deriveKey(B64_KEY))).toBe(true);
  });
});

describe('encryptToken / decryptToken accept a Buffer key', () => {
  for (const [name, text] of [['base64', B64_KEY], ['passphrase', PASSPHRASE]] as const) {
    it(`v1 round-trips across string and Buffer (${name})`, () => {
      const input = buf(text);
      const before = Buffer.from(input);
      expect(decryptToken(encryptToken(sample, text), input)).toEqual(sample);
      expect(decryptToken(encryptToken(sample, input), text)).toEqual(sample);
      expect(input.equals(before)).toBe(true);
    });

    it(`v2 round-trips across string and Buffer (${name})`, () => {
      expect(decryptToken(encryptToken(sample, text, 'tenant-a'), buf(text), 'tenant-a')).toEqual(sample);
      expect(decryptToken(encryptToken(sample, buf(text), 'tenant-a'), text, 'tenant-a')).toEqual(sample);
    });
  }

  it('a wrong Buffer key still fails authentication', () => {
    expect(() => decryptToken(encryptToken(sample, B64_KEY), buf(randomBytes(32).toString('base64')))).toThrow();
  });

  it('keeps working on the next call (the per-call key is wiped, the memoized tenant key is not)', () => {
    const input = buf(B64_KEY);
    for (let i = 0; i < 3; i++) {
      expect(decryptToken(encryptToken(sample, input), input)).toEqual(sample);
      expect(decryptToken(encryptToken(sample, input, 't'), input, 't')).toEqual(sample);
    }
  });

  it('wipeTenantKeyMemo overwrites the memoized subkey and the next call derives it again', () => {
    const first = deriveTenantKey(B64_KEY, 'wipe-me');
    const copy = Buffer.from(first);
    wipeTenantKeyMemo();
    expect(first.equals(copy)).toBe(false);
    expect(deriveTenantKey(B64_KEY, 'wipe-me').equals(copy)).toBe(true);
  });
});

describe('createTokenStore with a Buffer key', () => {
  it('reads and writes, and interoperates with a string-keyed store', () => {
    const viaBuf = createTokenStore(dir, { resolveKey: () => buf(B64_KEY) });
    const viaStr = createTokenStore(dir, { resolveKey: () => B64_KEY });
    viaBuf.writeToken('acct', sample);
    expect(viaStr.readToken('acct')).toEqual(sample);
    viaStr.updateToken('acct', { access_token: 'b' });
    expect(viaBuf.readToken('acct')).toEqual({ ...sample, access_token: 'b' });
  });

  it('tenant-keyed store round-trips with a Buffer key', () => {
    const viaBuf = createTokenStore(dir, { tenantId: 'tx', resolveKey: () => buf(PASSPHRASE) });
    const viaStr = createTokenStore(dir, { tenantId: 'tx', resolveKey: () => PASSPHRASE });
    viaBuf.writeToken('acct', sample);
    expect(viaStr.readToken('acct')).toEqual(sample);
  });
});

describe('mcp-token with Buffer keys', () => {
  it('jwtSecretFrom gives the same secret for either form and leaves the input alone', () => {
    const input = buf(B64_KEY);
    const before = Buffer.from(input);
    expect(Buffer.from(jwtSecretFrom(input)).equals(Buffer.from(jwtSecretFrom(B64_KEY)))).toBe(true);
    expect(Buffer.from(jwtSecretFrom(buf(PASSPHRASE))).equals(Buffer.from(jwtSecretFrom(PASSPHRASE)))).toBe(true);
    expect(input.equals(before)).toBe(true);
    expect(jwtSecretFrom(input)).toBeInstanceOf(Uint8Array);
  });

  it('a RefreshStore keyed by a Buffer reads what a string-keyed store wrote, and the reverse', () => {
    const file = path.join(dir, 'mcp-tokens.enc');
    const now = Date.now();
    const withStr = new RefreshStore(file, PASSPHRASE);
    const t1 = withStr.issue(now, 'sub-1');
    const withBuf = new RefreshStore(file, buf(PASSPHRASE));
    const t2 = withBuf.rotate(t1, now + 1_000);
    expect(t2?.sub).toBe('sub-1');
    const t3 = withStr.rotate(t2!.token, now + 2_000);
    expect(t3?.sub).toBe('sub-1');
  });

  it('refreshFamilyTagger tags a token the same under either form', () => {
    const file = path.join(dir, 'mcp-tokens.enc');
    const token = new RefreshStore(file, B64_KEY).issue(Date.now(), 'sub-2');
    const tag = refreshFamilyTagger(B64_KEY)(token);
    expect(tag).not.toBeNull();
    expect(refreshFamilyTagger(buf(B64_KEY))(token)).toBe(tag);
  });

  it('wipeRefreshKeyMemo overwrites the memoized MAC key', () => {
    const mac = refreshMacKey(B64_KEY);
    const copy = Buffer.from(mac);
    wipeRefreshKeyMemo();
    expect(mac.equals(copy)).toBe(false);
    expect(refreshMacKey(B64_KEY).equals(copy)).toBe(true);
  });
});

describe('resolved keys', () => {
  const noKeychain = () => null;
  const base = (over: object = {}) => ({ dir, keychain: noKeychain, hasAnyToken: () => false, ...over });

  it('exposes the key as a string and as bytes, and only the string is enumerable', () => {
    const r = resolveMasterKey(base({ env: { MASTER_KEY: ` ${PASSPHRASE} ` } as NodeJS.ProcessEnv }));
    expect(r.key).toBe(PASSPHRASE);
    expect(r.bytes.equals(buf(PASSPHRASE))).toBe(true);
    expect(r).toEqual({ key: PASSPHRASE, provenance: 'env' });
    expect(Object.keys(r).sort()).toEqual(['key', 'provenance']);
    expect(JSON.parse(JSON.stringify(r))).toEqual({ key: PASSPHRASE, provenance: 'env' });
  });

  it('bytes drives the token APIs exactly like key', () => {
    const r = resolveMasterKey(base({ env: { MASTER_KEY: B64_KEY } as NodeJS.ProcessEnv }));
    expect(decryptToken(encryptToken(sample, r.bytes), r.key)).toEqual(sample);
  });

  it('a keychain that returns a Buffer works', () => {
    const r = resolveMasterKey(base({ env: {} as NodeJS.ProcessEnv, keychain: () => ({ get: () => buf(PASSPHRASE), set: () => undefined, del: () => undefined }) }));
    expect(r).toEqual({ key: PASSPHRASE, provenance: 'keychain' });
    expect(r.bytes.equals(buf(PASSPHRASE))).toBe(true);
  });

  it('a file is trimmed as before: CRLF, ASCII padding, BOM, no-break space', () => {
    const nbsp = String.fromCharCode(0xa0);
    const bom = String.fromCharCode(0xfeff);
    for (const raw of [`${PASSPHRASE}\r\n`, `\n\t ${PASSPHRASE} \n\n`, `${bom}${PASSPHRASE}\n`, `${nbsp}${PASSPHRASE}${nbsp}\n`]) {
      writeFileSync(path.join(dir, 'master.key'), raw);
      const r = resolveMasterKey(base({ env: {} as NodeJS.ProcessEnv }));
      expect(r).toEqual({ key: PASSPHRASE, provenance: 'file' });
      expect(r.bytes.equals(buf(PASSPHRASE))).toBe(true);
    }
  });

  it('a non-ASCII passphrase in a file survives byte for byte', () => {
    writeFileSync(path.join(dir, 'master.key'), 'pässwörd-日本語\n');
    expect(resolveMasterKey(base({ env: {} as NodeJS.ProcessEnv })).key).toBe('pässwörd-日本語');
  });

  it('a generated key is usable as bytes and matches the file it was stored in', () => {
    const r = resolveMasterKey(base({ env: {} as NodeJS.ProcessEnv }));
    expect(r.provenance).toBe('generated');
    expect(r.bytes).toHaveLength(44);
    const again = resolveMasterKey(base({ env: {} as NodeJS.ProcessEnv }));
    expect(again.provenance).toBe('file');
    expect(again.bytes.equals(r.bytes)).toBe(true);
  });
});

describe('env scrub', () => {
  it('does not touch the env unless asked', () => {
    const env = { MASTER_KEY: B64_KEY } as NodeJS.ProcessEnv;
    resolveMasterKey({ env, dir, keychain: () => null, hasAnyToken: () => false });
    expect(env.MASTER_KEY).toBe(B64_KEY);
  });

  it('deletes the var after the read when deps.scrubEnv is set, and the result is still valid', () => {
    const env = { MASTER_KEY: B64_KEY, MCP_JWT_KEY: PASSPHRASE } as NodeJS.ProcessEnv;
    const deps = { env, dir, keychain: () => null, hasAnyToken: () => false, scrubEnv: true };
    const m = resolveMasterKey(deps);
    const j = resolveJwtKey(deps);
    expect(env.MASTER_KEY).toBeUndefined();
    expect(env.MCP_JWT_KEY).toBeUndefined();
    expect(m.key).toBe(B64_KEY);
    expect(j.key).toBe(PASSPHRASE);
  });

  it('leaves the var when nothing was read (empty value) and when resolution fails', () => {
    const env = { MASTER_KEY: '   ' } as NodeJS.ProcessEnv;
    expect(() =>
      resolveMasterKey({ env, dir, keychain: () => null, hasAnyToken: () => true, scrubEnv: true }),
    ).toThrow();
    expect(env.MASTER_KEY).toBe('   ');
  });

  it('the cached form keeps serving the key after process.env is scrubbed', () => {
    process.env.MASTER_KEY = B64_KEY;
    process.env.MCP_JWT_KEY = PASSPHRASE;
    setScrubKeyEnv(true);
    const first = resolveMasterKey();
    const jwt = resolveJwtKey();
    expect(process.env.MASTER_KEY).toBeUndefined();
    expect(process.env.MCP_JWT_KEY).toBeUndefined();
    const second = resolveMasterKey();
    expect(second).toBe(first);
    expect(second.key).toBe(B64_KEY);
    expect(resolveJwtKey().key).toBe(jwt.key);
    expect(decryptToken(encryptToken(sample, second.bytes), B64_KEY)).toEqual(sample);
  });

  it('diagnostics still see an env-sourced key after the scrub', () => {
    process.env.MASTER_KEY = B64_KEY;
    setScrubKeyEnv(true);
    resolveMasterKey();
    expect(process.env.MASTER_KEY).toBeUndefined();
    expect(peekMasterKeyProvenance()).toBe('env');
    expect(deleteMasterKeyMaterial({ dir, keychain: () => null }).env).toBe(true);
    // The scrubbed key lives only in the cache, so the delete must not drop it.
    expect(resolveMasterKey().key).toBe(B64_KEY);
  });
});

describe('wipeKeyCache', () => {
  it('overwrites the cached bytes (a handed-out result fails closed) and drops the cache', () => {
    process.env.MASTER_KEY = B64_KEY;
    const r = resolveMasterKey();
    expect(r.bytes.equals(buf(B64_KEY))).toBe(true);
    wipeKeyCache();
    expect(r.bytes.equals(buf(B64_KEY))).toBe(false);
    expect(resolveMasterKey().key).toBe(B64_KEY);
    expect(resolveMasterKey()).not.toBe(r);
  });
});
