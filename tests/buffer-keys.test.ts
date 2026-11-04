import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { base64KeyBytes, KeyMemo, wipeBytes } from '../src/key-material.js';
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

  it('KeyMemo matches on key bytes across string and Buffer, per sub id', () => {
    const memo = new KeyMemo();
    const v = Buffer.from('derived');
    memo.set(PASSPHRASE, v, 't1');
    expect(memo.get(buf(PASSPHRASE), 't1')).toBe(v);
    expect(memo.get(`${PASSPHRASE}x`, 't1')).toBeUndefined();
    expect(memo.get(PASSPHRASE, 't2')).toBeUndefined();
    memo.wipe();
    expect(memo.get(PASSPHRASE, 't1')).toBeUndefined();
    expect(v.equals(Buffer.from('derived'))).toBe(false);
  });
});

// Computed with dev 45842e2's algorithm (string keys): deriveKey is base64 of
// exactly 32 bytes or bare sha256 of the UTF-8 text; the refresh MAC key is
// HKDF over the same raw key, or over scrypt of the text for a passphrase.
// Key text is given as code points so the file holds no hidden characters.
const GOLDEN: Array<{ name: string; cps: number[]; branch: 'raw' | 'sha256'; derive: string; mac: string }> = [
  { name: 'b64', cps: [65, 119, 111, 82, 71, 66, 56, 109, 76, 84, 81, 55, 81, 107, 108, 81, 86, 49, 53, 108, 98, 72, 78, 54, 103, 89, 105, 80, 108, 112, 50, 107, 113, 55, 75, 53, 119, 77, 102, 79, 49, 100, 119, 61], branch: 'raw', derive: '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dc', mac: 'e5d998557373d7268553fa15b1ac813902cdaf8f1dd500d0d53977eefd03c48c' },
  { name: 'passphrase', cps: [99, 111, 114, 114, 101, 99, 116, 32, 104, 111, 114, 115, 101, 32, 98, 97, 116, 116, 101, 114, 121, 32, 115, 116, 97, 112, 108, 101], branch: 'sha256', derive: 'c4bbcb1fbec99d65bf59d85c8cb62ee2db963f0fe106f483d9afa73bd4e39a8a', mac: '5ecec63e53c030b3e4a7ca576875e6e1b99d93023584a59b16fdc14448c88e76' },
  { name: 'latin1', cps: [99, 108, 233, 45, 115, 101, 99, 114, 232, 116, 101, 45, 65, 119, 111, 82, 71, 66, 56, 109, 76, 84, 81, 55, 81, 107, 108, 81, 86, 49, 53, 108], branch: 'sha256', derive: '7e774d4913d619524b5bc04a2087be41178788a718e790aba07222593e2036be', mac: '282be6b8059c82334652f9df1cb6949ef46a0334249a05e196fb2f16878d5774' },
  { name: 'han', cps: [23383, 65, 119, 111, 82, 71, 66, 56, 109, 76, 84, 81, 55, 81, 107, 108, 81, 86, 49, 53, 108, 98, 72, 78, 54, 103, 89, 105, 80, 108, 112, 50, 107, 113, 55, 75, 53, 119, 77, 102, 79, 49, 100, 119, 61], branch: 'sha256', derive: '9b50e10c2ee866153e338a40689b77811b6d0e178b8bd736164bb52d5a6c3d07', mac: 'bf8620a3630a82d943c2ee91243cd8b1664fc8489a392151125590d9c26bf7f0' },
  { name: 'emoji', cps: [128273, 65, 119, 111, 82, 71, 66, 56, 109, 76, 84, 81, 55, 81, 107, 108, 81, 86, 49, 53, 108, 98, 72, 78, 54, 103, 89, 105, 80, 108, 112, 50, 107, 113, 55, 75, 53, 119, 77, 102, 79, 49, 100, 119, 61], branch: 'sha256', derive: '085bcc037626a7b8d652bdc74c13b8299e102df9a99a3ab7e25521a452865459', mac: 'fb963565e6a61fe0ba295797a8d6a3143f8a6067dd01b05b8106874223407c40' },
  { name: 'lcaron', cps: [317, 65, 119, 111, 82, 71, 66, 56, 109, 76, 84, 81, 55, 81, 107, 108, 81, 86, 49, 53, 108, 98, 72, 78, 54, 103, 89, 105, 80, 108, 112, 50, 107, 113, 55, 75, 53, 119, 77, 102, 79, 49, 100, 119, 61], branch: 'sha256', derive: '9763121ac75e95ec0853cd184acc620dddda044acd8ce68be89204b02f05e723', mac: 'ceb15e62f3e4a155fd68668fec67f6372f97dc6e27186efea2e533c04930baaf' },
  { name: 'arabic43', cps: [1605, 1601, 1578, 1575, 1581, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97], branch: 'sha256', derive: '274cdb82d00a580063bf0a5600fc0c1243b3e42b2da34ca778a9753d416a4d81', mac: '5286bf35e1583607eaec0f08cd22d51512e370d8576cf3edddff24a7689ac5d4' },
  { name: 'han43', cps: [65, 65, 65, 65, 65, 65, 65, 65, 65, 65, 65, 65, 65, 65, 65, 65, 65, 65, 65, 65, 65, 23383, 66, 66, 66, 66, 66, 66, 66, 66, 66, 66, 66, 66, 66, 66, 66, 66, 66, 66, 66, 66, 66], branch: 'raw', derive: '0000000000000000000000000000000160410410410410410410410410410410', mac: 'afd04d074227208f52ebfcf5056280391f63d455cc7e88cb6e2ad8c43332e687' },
  { name: 'arabicDash43', cps: [1581, 90, 109, 57, 118, 90, 109, 57, 118, 90, 109, 57, 118, 90, 109, 57, 118, 90, 109, 57, 118, 90, 109, 57, 118, 90, 109, 57, 118, 90, 109, 57, 118, 90, 109, 57, 118, 90, 109, 57, 118, 90, 109, 57], branch: 'sha256', derive: '644c7c2ba1347b1f5f95bbb2bda05ca6e0c91af53b281f47f3d0954d0980052b', mac: 'c6363672a790d273c08506c3679f013cc557597723feba89f54ebf2226df897d' },
  { name: 'arabicMixed', cps: [1605, 1601, 1578, 1575, 1581, 32, 1587, 1585, 1610, 32, 65, 119, 111, 82, 71, 66, 56, 109, 76, 84, 81, 55, 81, 107, 108, 81, 86, 49, 53, 108, 98, 72, 78, 54, 103, 89, 105, 80, 108, 112], branch: 'sha256', derive: '90b3813a0690b4b9224b63d152d1ae8d058a5b50e931bee2c7dab36927972d90', mac: 'a00f22cec1b49f8dd0828f694eba83ad38ccc03a2b80898ce2b82754855a91d1' },
];
const textOf = (cps: number[]): string => String.fromCodePoint(...cps);

describe('golden vectors from dev: string and Buffer both derive the old keys', () => {
  for (const g of GOLDEN) {
    it(`${g.name} (${g.branch} branch)`, () => {
      const text = textOf(g.cps);
      for (const form of [text, buf(text)]) {
        expect(deriveKey(form).toString('hex')).toBe(g.derive);
        expect(refreshMacKey(form).toString('hex')).toBe(g.mac);
        expect(base64KeyBytes(form) !== null).toBe(g.branch === 'raw');
      }
    });
  }

  it('a Buffer takes the same branch as the equal string for characters above U+00FF', () => {
    const B64 = 'AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw=';
    for (const text of ['\u5b57' + B64, String.fromCodePoint(0x1f511) + B64, '\u013d' + B64, 'A'.repeat(21) + '\u5b57' + 'B'.repeat(21)]) {
      expect(base64KeyBytes(buf(text))?.toString('hex')).toBe(base64KeyBytes(text)?.toString('hex'));
    }
  });

  it('fuzz: random keys with characters above U+00FF derive the same in both forms', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/-_= ';
    const wide = [0x13d, 0x5b57, 0x62d, 0x627, 0xe9, 0x1f511, 0x1d11e, 0xfeff, 0x2028];
    const pick = (): string => (Math.random() < 0.2 ? String.fromCodePoint(wide[Math.floor(Math.random() * wide.length)]) : alphabet[Math.floor(Math.random() * alphabet.length)]);
    for (let i = 0; i < 400; i++) {
      const len = 36 + Math.floor(Math.random() * 14);
      const text = Array.from({ length: len }, pick).join('');
      expect(deriveKey(buf(text)).toString('hex')).toBe(deriveKey(text).toString('hex'));
    }
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
    expect(() => deriveTenantKey(B64_KEY, 'wipe-me')).toThrow(/E_KEYS_WIPED/);
    clearKeyCacheForTest();
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
    expect(() => refreshMacKey(B64_KEY)).toThrow(/E_KEYS_WIPED/);
    clearKeyCacheForTest();
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

describe('after a wipe, encryption and MAC minting fail closed', () => {
  it('wipeKeyCache: a RefreshStore built before it throws on write and writes nothing', () => {
    process.env.MASTER_KEY = B64_KEY;
    const file = path.join(dir, 'refresh.enc');
    const store = new RefreshStore(file, resolveMasterKey().bytes);
    wipeKeyCache();
    expect(() => store.issue(Date.now(), 'sub')).toThrow(/E_KEYS_WIPED/);
    expect(existsSync(file)).toBe(false);
    expect(() => encryptToken(sample, B64_KEY)).toThrow(/E_KEYS_WIPED/);
    expect(() => deriveKey(B64_KEY)).toThrow(/E_KEYS_WIPED/);
  });

  it('a fresh resolve re-arms the module, but the old store stays refused', () => {
    process.env.MASTER_KEY = B64_KEY;
    const file = path.join(dir, 'refresh.enc');
    const old = new RefreshStore(file, resolveMasterKey().bytes);
    wipeKeyCache();
    const next = new RefreshStore(file, resolveMasterKey().bytes);
    expect(() => old.issue(Date.now(), 'sub')).toThrow(/E_KEYS_WIPED/);
    expect(() => next.issue(Date.now(), 'sub')).not.toThrow();
    expect(existsSync(file)).toBe(true);
  });

  it('wipeRefreshKeyMemo: the family tagger and a store built earlier throw', () => {
    const tagger = refreshFamilyTagger(B64_KEY);
    const file = path.join(dir, 'refresh.enc');
    const store = new RefreshStore(file, B64_KEY);
    wipeRefreshKeyMemo();
    expect(() => tagger('x')).toThrow(/E_KEYS_WIPED/);
    expect(() => store.issue(Date.now(), 'sub')).toThrow(/E_KEYS_WIPED/);
    expect(existsSync(file)).toBe(false);
  });
});

describe('explicit deps do not take the process-wide scrub default', () => {
  it('resolveMasterKey({ dir }) keeps process.env when setScrubKeyEnv(true)', () => {
    process.env.MASTER_KEY = B64_KEY;
    setScrubKeyEnv(true);
    expect(resolveMasterKey({ dir, keychain: () => null }).key).toBe(B64_KEY);
    expect(process.env.MASTER_KEY).toBe(B64_KEY);
    expect(resolveJwtKey({ dir, keychain: () => null }).key.length).toBeGreaterThan(0);
  });

  it('an explicit scrubEnv: true on an injected env still scrubs that env', () => {
    const env: NodeJS.ProcessEnv = { MASTER_KEY: B64_KEY };
    resolveMasterKey({ env, dir, keychain: () => null, scrubEnv: true });
    expect(env.MASTER_KEY).toBeUndefined();
  });
});
