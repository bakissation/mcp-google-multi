import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { rmSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SignJWT } from 'jose';
import {
  jwtSecretFrom,
  signAccessToken,
  verifyAccessToken,
  signState,
  verifyState,
  signAuthzCode,
  verifyAuthzCode,
  signReauthLink,
  verifyReauthLink,
  REAUTH_LINK_TTL_SEC,
  ReplayGuard,
  RefreshStore,
  assertRefreshStoreReadable,
  refreshFamilyTagger,
  type RefreshStoreOptions,
  type StatePayload,
} from '../src/mcp-token.js';
import { withFileLock } from '../src/fs-atomic.js';
import { decryptToken, encryptToken } from '../src/token-store.js';
import { RefreshStore as PrevRefreshStore } from './fixtures/refresh-store-prev.js';
import { legacyTok, onDisk, r1Bytes, seedFamilies, seedLegacy, specKey, specMac, specTag, specToken } from './_refresh-spec.js';

const BASE = 'https://mcp.example.com';
const secret = jwtSecretFrom('dGVzdC1qd3Qta2V5LXRoYXQtaXMtMzItYnl0ZXMh'); // any string key
const other = jwtSecretFrom('a-different-key');
const iat = Math.floor(Date.now() / 1000);

describe('MCP access token (HS256)', () => {
  it('round-trips with the right issuer + audience', async () => {
    const t = await signAccessToken({ base: BASE, secret, iat, sub: 'owner' });
    const claims = await verifyAccessToken(t, BASE, secret);
    expect(claims.sub).toBe('owner'); // the explicitly passed sub, no longer hardcoded
    expect(claims.scope).toBe('mcp:use');
  });
  it('rejects a wrong signing key', async () => {
    const t = await signAccessToken({ base: BASE, secret, iat, sub: 'owner' });
    await expect(verifyAccessToken(t, BASE, other)).rejects.toBeTruthy();
  });
  it('rejects a wrong audience/issuer', async () => {
    const t = await signAccessToken({ base: BASE, secret, iat, sub: 'owner' });
    await expect(verifyAccessToken(t, 'https://evil.example', secret)).rejects.toBeTruthy();
  });
  it('rejects an expired token', async () => {
    const t = await signAccessToken({ base: BASE, secret, iat: iat - 10_000, ttlSec: 600, sub: 'owner' });
    await expect(verifyAccessToken(t, BASE, secret)).rejects.toBeTruthy();
  });
  it('carries a non-owner sub (tenant id) through sign and verify', async () => {
    const t = await signAccessToken({ base: BASE, secret, iat, sub: 'tenant-a' });
    const claims = await verifyAccessToken(t, BASE, secret);
    expect(claims.sub).toBe('tenant-a');
  });
  it('refuses a token with no string subject, and never signs one', async () => {
    const noSub = await new SignJWT({ scope: 'mcp:use', purpose: 'mcp_access' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(BASE)
      .setAudience(`${BASE}/mcp`)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 600)
      .sign(secret);
    await expect(verifyAccessToken(noSub, BASE, secret)).rejects.toThrow('access token has no subject');
    await expect(signAccessToken({ base: BASE, secret, iat, sub: undefined as unknown as string })).rejects.toThrow('sub must be a non-empty string');
    await expect(signAccessToken({ base: BASE, secret, iat, sub: '' })).rejects.toThrow('sub must be a non-empty string');
  });
  it('a state token cannot be used as an access token (purpose separation)', async () => {
    const st = await signState({ flow: 'owner_gate', client_id: 'c', redirect_uri: 'r', code_challenge: 'x', resource: `${BASE}/mcp` }, BASE, secret, iat);
    await expect(verifyAccessToken(st, BASE, secret)).rejects.toBeTruthy();
  });
});

describe('signed state + authz code', () => {
  const payload: StatePayload = { flow: 'owner_gate', client_id: 'cid', redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: 'abc', client_state: 'cs', resource: `${BASE}/mcp` };
  it('state round-trips and carries a jti', async () => {
    const st = await signState(payload, BASE, secret, iat);
    const back = await verifyState(st, BASE, secret);
    expect(back.flow).toBe('owner_gate');
    expect(back.redirect_uri).toBe(payload.redirect_uri);
    expect(back.jti).toBeTruthy();
  });
  it('rejects a tampered state', async () => {
    const st = await signState(payload, BASE, secret, iat);
    await expect(verifyState(st.slice(0, -2) + 'xy', BASE, secret)).rejects.toBeTruthy();
  });
  it('rejects an expired state and an expired code', async () => {
    const st = await signState(payload, BASE, secret, iat - 10_000, 600);
    await expect(verifyState(st, BASE, secret)).rejects.toBeTruthy();
    const code = await signAuthzCode({ redirect_uri: 'r', code_challenge: 'abc', resource: `${BASE}/mcp`, sub: 'owner' }, BASE, secret, iat - 10_000, 60);
    await expect(verifyAuthzCode(code, BASE, secret)).rejects.toBeTruthy();
  });
  it('authz code round-trips; an access token is not a code', async () => {
    const code = await signAuthzCode({ redirect_uri: 'r', code_challenge: 'abc', resource: `${BASE}/mcp`, sub: 'owner' }, BASE, secret, iat);
    const back = await verifyAuthzCode(code, BASE, secret);
    expect(back.sub).toBe('owner');
    const access = await signAccessToken({ base: BASE, secret, iat, sub: 'owner' });
    await expect(verifyAuthzCode(access, BASE, secret)).rejects.toBeTruthy();
  });
});

describe('ReplayGuard (C10/C17)', () => {
  it('accepts a jti once, rejects the replay', () => {
    const g = new ReplayGuard();
    expect(g.consume('j1', 1000, 0)).toBe(true);
    expect(g.consume('j1', 1000, 100)).toBe(false);
  });
  it('re-accepts after TTL eviction', () => {
    const g = new ReplayGuard();
    expect(g.consume('j1', 1000, 0)).toBe(true);
    expect(g.consume('j1', 1000, 2000)).toBe(true); // prior expired at 1000
  });
  it('bounds memory at the cap', () => {
    const g = new ReplayGuard(3);
    for (let i = 0; i < 10; i++) g.consume(`j${i}`, 100_000, 0);
    expect(g.size).toBeLessThanOrEqual(3);
  });
  it('refuses rather than forgets a live jti when full (H4 F1)', () => {
    const g = new ReplayGuard(2);
    expect(g.spend('a', 1000, 0)).toBe('ok');
    expect(g.spend('b', 1000, 0)).toBe('ok');
    expect(g.spend('c', 1000, 10)).toBe('full');
    expect(g.consume('c', 1000, 10)).toBe(false);
    expect(g.spend('a', 1000, 20)).toBe('replay');
    expect(g.size).toBe(2);
    expect(g.spend('c', 1000, 1000)).toBe('ok');
  });
  it('a reserved jti is spent once, even while the guard is full', () => {
    const g = new ReplayGuard(2);
    expect(g.reserve('r', 1000, 0)).toBe('ok');
    expect(g.spend('x', 1000, 0)).toBe('ok');
    expect(g.reserve('r2', 1000, 10)).toBe('full');
    expect(g.spend('y', 1000, 10)).toBe('full');
    expect(g.spend('r', 1000, 20)).toBe('ok');
    expect(g.spend('r', 1000, 30)).toBe('replay');
    expect(g.size).toBe(2);
  });
  it('a full guard sweeps at most once a second', () => {
    const g = new ReplayGuard(2);
    g.spend('long', 10_000, 0);
    g.spend('s1', 100, 0);
    expect(g.spend('x', 100, 200)).toBe('ok'); // sweeps s1 out
    expect(g.spend('y', 100, 400)).toBe('full'); // x expired at 300, but the last sweep was 200 ms ago
    expect(g.spend('y', 100, 1200)).toBe('ok');
  });
  it("a spend lasts as long as the artifact's own expiry, if that is later", () => {
    const g = new ReplayGuard();
    expect(g.spend('j', 100, 0, 5000)).toBe('ok');
    expect(g.spend('j', 100, 1000)).toBe('replay');
    expect(g.spend('j', 100, 5000)).toBe('ok');
  });
  it('an expired jti behind a longer-lived one is accepted again, and makes room when full', () => {
    const g = new ReplayGuard(2);
    expect(g.spend('long', 10_000, 0)).toBe('ok');
    expect(g.spend('short', 100, 0)).toBe('ok');
    expect(g.spend('short', 100, 200)).toBe('ok');
    expect(g.spend('long', 10_000, 200)).toBe('replay');
    expect(g.spend('other', 100, 400)).toBe('ok');
  });
});

describe('RefreshStore (C14 rotation)', () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const store = () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gm-refresh-'));
    return new RefreshStore(path.join(dir, 'mcp-tokens.enc'), 'master-key-for-test');
  };

  it('rotates on each use; a clean chain keeps working', () => {
    const s = store();
    const t1 = s.issue(1000, 'owner');
    const t2 = s.rotate(t1, 2000);
    expect(t2).toBeTruthy();
    expect(t2!.token).not.toBe(t1);
    const t3 = s.rotate(t2!.token, 3000);
    expect(t3).toBeTruthy();
    expect(t3!.token).not.toBe(t2!.token);
  });
  it('reuse of a rotated-away token revokes the whole family (#7)', () => {
    const s = store();
    const t1 = s.issue(1000, 'owner');
    const t2 = s.rotate(t1, 2000);
    // t1 was rotated away; presenting it again is theft -> revoke the family
    expect(s.rotate(t1, 3000)).toBeNull();
    // ...which also kills the currently-active token t2
    expect(s.rotate(t2!.token, 4000)).toBeNull();
  });
  it('rejects an unknown refresh token', () => {
    const s = store();
    expect(s.rotate('never-issued', 1000)).toBeNull();
  });

  it('carries an arbitrary sub end to end and copies it forward on every rotation (S1.3)', () => {
    const s = store();
    const t1 = s.issue(1000, 'tenant-a');
    const r1 = s.rotate(t1, 2000);
    expect(r1!.sub).toBe('tenant-a');
    // the record the store now holds (not just the return value) must carry it
    const r2 = s.rotate(r1!.token, 3000);
    expect(r2!.sub).toBe('tenant-a');
  });
  it('cross-sub isolation: revoking one sub\'s family never touches another sub\'s chain', () => {
    const s = store();
    const tA = s.issue(1000, 'tenant-a');
    const tB = s.issue(1000, 'tenant-b');
    const rA = s.rotate(tA, 2000);
    // reuse of tA is theft: kills tenant-a's family...
    expect(s.rotate(tA, 3000)).toBeNull();
    expect(s.rotate(rA!.token, 4000)).toBeNull();
    // ...while tenant-b's chain still rotates, sub intact
    const rB = s.rotate(tB, 5000);
    expect(rB!.sub).toBe('tenant-b');
  });
});

describe('RefreshStore looks up own keys only', () => {
  const INHERITED = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const storeAt = () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gm-ownkey-'));
    const file = path.join(dir, 'mcp-tokens.enc');
    return { s: new RefreshStore(file, 'master-key-for-test'), file };
  };

  it('an inherited object key is not a refresh token: nothing is minted and no file is written', () => {
    const { s, file } = storeAt();
    for (const k of INHERITED) expect(s.rotate(k, 1000)).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it('an inherited object key leaves an existing store untouched', () => {
    const { s, file } = storeAt();
    const t = s.issue(1000, 'owner');
    const before = readFileSync(file);
    for (const k of INHERITED) expect(s.rotate(k, 2000)).toBeNull();
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(s.rotate(t, 3000)!.sub).toBe('owner');
  });

  it('a record without a string subject or family loads as absent', () => {
    const { s, file } = storeAt();
    const tok = (label: string) => label.padEnd(43, '0');
    const active = {
      [tok('no-sub')]: { issuedAt: 1000, family: 'fam-a' },
      [tok('empty-sub')]: { sub: '', issuedAt: 1000, family: 'fam-a' },
      [tok('no-family')]: { sub: 'owner', issuedAt: 1000 },
      [tok('not-an-object')]: 'owner',
      [tok('good')]: { sub: 'owner', issuedAt: 1000, family: 'fam-b' },
    };
    writeFileSync(file, encryptToken({ active, spent: { [tok('bad-spent')]: 7 } }, 'master-key-for-test'), { mode: 0o600 });
    for (const t of ['no-sub', 'empty-sub', 'no-family', 'not-an-object', 'bad-spent']) expect(s.rotate(tok(t), 2000)).toBeNull();
    expect(s.rotate(tok('good'), 2000)!.sub).toBe('owner');
  });
});

describe('RefreshStore file format', () => {
  const KEY = 'master-key-for-test';
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const storeAt = () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gm-format-'));
    const file = path.join(dir, 'mcp-tokens.enc');
    return { s: new RefreshStore(file, KEY), file };
  };
  const plain = (file: string) => decryptToken(readFileSync(file, 'utf-8'), KEY) as unknown as Record<string, unknown>;
  const isMap = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v);

  it('writes format 2 and keeps object-typed active and spent maps an earlier release reads', () => {
    const { s, file } = storeAt();
    s.rotate(s.issue(1000, 'owner'), 2000);
    const d = plain(file);
    expect(d.format).toBe(2);
    expect(isMap(d.families)).toBe(true);
    expect(isMap(d.active)).toBe(true);
    expect(isMap(d.spent)).toBe(true);
  });

  it('refuses a file a newer release wrote instead of reading it as empty', () => {
    const { s, file } = storeAt();
    const legacy = 'L'.repeat(43);
    writeFileSync(file, encryptToken({ format: 3, families: {}, active: { [legacy]: { sub: 'owner', issuedAt: 1000, family: 'fam-a' } }, spent: {} }, KEY), { mode: 0o600 });
    const before = readFileSync(file);
    const calls: [string, () => unknown][] = [
      ['rotate', () => s.rotate(legacy, 2000)],
      ['issue', () => s.issue(2000, 'owner')],
      ['purgeTenant', () => s.purgeTenant('owner')],
      ['assertRefreshStoreReadable', () => assertRefreshStoreReadable(file, KEY)],
    ];
    for (const [name, call] of calls) {
      let err: unknown;
      try {
        call();
      } catch (e) {
        err = e;
      }
      expect(err, name).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg, name).toMatch(/^E_REFRESH_STORE_FORMAT: mcp-tokens\.enc was written by a newer release \(format 3\)/);
      expect(msg, name).not.toContain(dir);
      expect(readFileSync(file).equals(before), name).toBe(true);
    }
  });

  it('assertRefreshStoreReadable returns for an absent or current file and throws for another key', () => {
    const { s, file } = storeAt();
    expect(() => assertRefreshStoreReadable(file, KEY)).not.toThrow();
    s.issue(1000, 'owner');
    expect(() => assertRefreshStoreReadable(file, KEY)).not.toThrow();
    expect(() => assertRefreshStoreReadable(file, 'another-master-key')).toThrow(/^E_REFRESH_STORE_UNREADABLE: mcp-tokens\.enc does not decrypt/);
  });
});

describe('RefreshStore generations (F2)', () => {
  const KEY = 'master-key-for-test';
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const storeAt = (mk = KEY) => {
    dir = mkdtempSync(path.join(tmpdir(), 'gm-gen-'));
    const file = path.join(dir, 'mcp-tokens.enc');
    const logs: string[] = [];
    return { s: new RefreshStore(file, mk, { log: (l) => logs.push(l) }), file, logs };
  };
  const fam = (sub: string, gen: number, cur: string, extra: Record<string, unknown> = {}) => ({ sub, gen, cur, createdAt: 1000, usedAt: 1000, ...extra });
  const chain = (s: RefreshStore, first: string, n: number): string[] => {
    const out = [first];
    for (let i = 0; i < n; i++) out.push(s.rotate(out[out.length - 1], 2000 + i)!.token);
    return out;
  };
  const fidOf = (token: string) => r1Bytes(token).subarray(0, 16);

  it('G0 known answer: key derivation, byte order and MAC input are pinned', () => {
    const MK = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
    const TOKEN = 'r1.EBESExQVFhcYGRobHB0eHwECAwSgoaKjpKWmp6ipqqusra6vae0HPY7R1kpwyrnP9flryVjpAG54fFMHUKGK8Sgywi0';
    expect(specKey(MK).toString('hex')).toBe('055e29c4600133162eabbd2f74bd5b34623da9509bcfb5cbbe7446f3ffd21891');
    const fid = Buffer.from(Array.from({ length: 16 }, (_, i) => 0x10 + i));
    const rand = Buffer.from(Array.from({ length: 16 }, (_, i) => 0xa0 + i));
    const spec = specToken(MK, fid, 0x01020304, { rand });
    expect(spec.token).toBe(TOKEN);
    const { s, file } = storeAt(MK);
    seedFamilies(file, MK, { [spec.fid]: fam('owner', 0x01020304, spec.cur) });
    const r = s.rotate(TOKEN, 2000);
    expect(r!.sub).toBe('owner');
    const next = r1Bytes(r!.token);
    expect(next.subarray(0, 16).equals(fid)).toBe(true);
    expect(next.readUInt32BE(16)).toBe(0x01020305);
    expect(next.subarray(36).equals(specMac(MK, next.subarray(0, 36)))).toBe(true);
    expect(onDisk(file, MK).families[spec.fid]).toMatchObject({ gen: 0x01020305, cur: createHash('sha256').update(next).digest('base64url') });
  });

  it('G0b a passphrase MASTER_KEY reaches the MAC key through scrypt, not one hash', () => {
    expect(specKey(KEY).toString('hex')).toBe('59ba1aac916a4f7289406e9bc6ecd9912b6520a68b9196e51c02a352ad673f3f');
    const { s, file } = storeAt();
    const t = s.issue(1000, 'owner');
    const bytes = r1Bytes(t);
    expect(bytes.subarray(36).equals(specMac(KEY, bytes.subarray(0, 36)))).toBe(true);
    const fastKey = Buffer.from('2ede0631587fbd67ddf3a92424936d10a19767a56d00134675a68e8d02d6c70d', 'hex');
    const fastMac = createHmac('sha256', fastKey).update('mcp-google-multi refresh r1\n').update(bytes.subarray(0, 36)).digest();
    const fast = specToken(KEY, fidOf(t), 0, { rand: bytes.subarray(20, 36), mac: fastMac }).token;
    expect(refreshFamilyTagger(KEY)(fast)).toBeNull();
    expect(s.rotate(fast, 2000)).toBeNull();
    expect(onDisk(file, KEY).families[fidOf(t).toString('base64url')]).toMatchObject({ gen: 0 });
  });

  it('G1 fifty rotations leave one family record and no rotated-away tokens', () => {
    const { s, file } = storeAt();
    const t = chain(s, s.issue(1000, 'owner'), 1);
    const afterOne = readFileSync(file, 'utf-8').length;
    chain(s, t[1], 49);
    const d = onDisk(file, KEY);
    expect(Object.values(d.families)).toEqual([expect.objectContaining({ sub: 'owner', gen: 50 })]);
    expect(d.active).toEqual({});
    expect(d.spent).toEqual({});
    expect(Math.abs(readFileSync(file, 'utf-8').length - afterOne)).toBeLessThanOrEqual(4);
  });

  it('G2 any rotated-away generation revokes the family, not just the previous one', () => {
    let { s, file } = storeAt();
    let t = chain(s, s.issue(1000, 'owner'), 5);
    expect(s.rotate(t[2], 9000)).toBeNull();
    expect(s.rotate(t[5], 9001)).toBeNull();
    expect(onDisk(file, KEY).families).toEqual({});
    rmSync(dir, { recursive: true, force: true });
    ({ s, file } = storeAt());
    t = chain(s, s.issue(1000, 'owner'), 5);
    expect(s.rotate(t[0], 9000)).toBeNull();
    expect(s.rotate(t[5], 9001)).toBeNull();
    expect(onDisk(file, KEY).families).toEqual({});
  });

  it('G3 a token 4,997 generations old still revokes; the current one at 5,000 rotates', () => {
    const { s, file, logs } = storeAt();
    const fid = randomBytes(16);
    const cur = specToken(KEY, fid, 5000);
    seedFamilies(file, KEY, { [cur.fid]: fam('owner', 5000, cur.cur) });
    expect(s.rotate(specToken(KEY, fid, 3).token, 2000)).toBeNull();
    expect(s.rotate(cur.token, 2001)).toBeNull();
    expect(onDisk(file, KEY).families).toEqual({});
    expect(logs).toEqual([`refresh family revoked: reuse tag=${specTag(fid)}`]);
    seedFamilies(file, KEY, { [cur.fid]: fam('owner', 5000, cur.cur) });
    const r = s.rotate(cur.token, 3000);
    expect(r!.sub).toBe('owner');
    expect(r1Bytes(r!.token).readUInt32BE(16)).toBe(5001);
  });

  it('G4 a flipped MAC byte is refused and the real token still rotates', () => {
    const { s } = storeAt();
    const t = s.issue(1000, 'owner');
    const b = r1Bytes(t);
    b[40] ^= 0x01;
    expect(s.rotate(`r1.${b.toString('base64url')}`, 2000)).toBeNull();
    expect(s.rotate(t, 2001)!.sub).toBe('owner');
  });

  it('G5 a forged older generation (random MAC) revokes nothing', () => {
    const { s, file } = storeAt();
    const t = chain(s, s.issue(1000, 'owner'), 1);
    const forged = specToken(KEY, fidOf(t[1]), 0, { mac: randomBytes(32) });
    const before = onDisk(file, KEY).families;
    expect(s.rotate(forged.token, 3000)).toBeNull();
    expect(onDisk(file, KEY).families).toEqual(before);
    expect(s.rotate(t[1], 3001)!.sub).toBe('owner');
  });

  it('G6 the current token with its random part altered and the original MAC is refused', () => {
    const { s } = storeAt();
    const t = s.issue(1000, 'owner');
    const b = r1Bytes(t);
    b[25] ^= 0x80;
    expect(s.rotate(`r1.${b.toString('base64url')}`, 2000)).toBeNull();
    expect(s.rotate(t, 2001)!.sub).toBe('owner');
  });

  it('G7 a token minted under another master key names nothing', () => {
    const { s } = storeAt();
    const t = chain(s, s.issue(1000, 'owner'), 1);
    expect(s.rotate(specToken('another-master-key', fidOf(t[1]), 0).token, 3000)).toBeNull();
    expect(s.rotate(specToken('another-master-key', fidOf(t[1]), 1).token, 3001)).toBeNull();
    expect(s.rotate(t[1], 3002)!.sub).toBe('owner');
  });

  it('G8 an issued token is r1 and the file holds neither it nor its body', () => {
    const { s, file } = storeAt();
    const t = s.issue(1000, 'owner');
    expect(t).toMatch(/^r1\.[A-Za-z0-9_-]{91}$/);
    const json = JSON.stringify(onDisk(file, KEY));
    expect(json).not.toContain(t);
    expect(json).not.toContain(t.slice(3));
    expect(json).not.toContain(r1Bytes(t).subarray(20, 36).toString('base64url'));
  });

  it('G9 one spelling per token: a re-spelled, shortened, lengthened or junk token is refused', () => {
    const { s } = storeAt();
    const t = s.issue(1000, 'owner');
    const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const respelled = t.slice(0, -1) + ABC[ABC.indexOf(t[t.length - 1]) ^ 1];
    expect(r1Bytes(respelled).equals(r1Bytes(t))).toBe(true);
    for (const x of [respelled, t.slice(0, -1), `${t}A`, `r1.${'*'.repeat(91)}`]) expect(s.rotate(x, 2000)).toBeNull();
    expect(s.rotate(t, 2001)!.sub).toBe('owner');
  });

  it('G10 a family at the last generation is dropped instead of throwing', () => {
    const { s, file, logs } = storeAt();
    const fid = randomBytes(16);
    const cur = specToken(KEY, fid, 0xffffffff);
    seedFamilies(file, KEY, { [cur.fid]: fam('owner', 0xffffffff, cur.cur) });
    expect(s.rotate(cur.token, 2000)).toBeNull();
    expect(onDisk(file, KEY).families).toEqual({});
    expect(logs).toEqual([`refresh family dropped: overflow tag=${specTag(fid)}`]);
  });

  it('G11 a reuse revokes its own family only: same-subject and other-subject families keep rotating', () => {
    const { s } = storeAt();
    const a = chain(s, s.issue(1000, 'tenant-a'), 1);
    const b = s.issue(1000, 'tenant-a');
    const c = s.issue(1000, 'tenant-b');
    expect(s.rotate(a[0], 3000)).toBeNull();
    expect(s.rotate(a[1], 3001)).toBeNull();
    expect(s.rotate(b, 3002)!.sub).toBe('tenant-a');
    expect(s.rotate(c, 3003)!.sub).toBe('tenant-b');
  });

  it('G12 a newer generation or a same-generation twin drops the family and says so, not theft', () => {
    const { s, file, logs } = storeAt();
    const fid = randomBytes(16);
    const cur = specToken(KEY, fid, 5);
    seedFamilies(file, KEY, { [cur.fid]: fam('owner', 5, cur.cur) });
    expect(s.rotate(specToken(KEY, fid, 6).token, 2000)).toBeNull();
    expect(onDisk(file, KEY).families).toEqual({});
    expect(s.rotate(cur.token, 2001)).toBeNull();
    seedFamilies(file, KEY, { [cur.fid]: fam('owner', 5, cur.cur) });
    expect(s.rotate(specToken(KEY, fid, 5).token, 3000)).toBeNull();
    expect(onDisk(file, KEY).families).toEqual({});
    expect(s.rotate(cur.token, 3001)).toBeNull();
    expect(logs).toEqual([`refresh family dropped: ahead tag=${specTag(fid)}`, `refresh family dropped: mismatch tag=${specTag(fid)}`]);
  });

  it('G13 a token that does not decode to exactly 68 bytes is refused without throwing', () => {
    const { s } = storeAt();
    const t = s.issue(1000, 'owner');
    const body = t.slice(3);
    const variants = [`r1.${body.slice(0, 90)}*`, `r1.${body.slice(0, 89)}**`, `r1.${body}AA`, `r1.${body.slice(0, 88)}`];
    for (const x of variants) expect(() => s.rotate(x, 2000)).not.toThrow();
    for (const x of variants) expect(s.rotate(x, 2000)).toBeNull();
    expect(s.rotate(t, 2001)!.sub).toBe('owner');
  });

  it('V1 a malformed family record is dropped on load and a good one keeps rotating', () => {
    const { s, file } = storeAt();
    const good = specToken(KEY, randomBytes(16), 0);
    const any = () => specToken(KEY, randomBytes(16), 0);
    const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const k = any();
    const nonCanonical = k.fid.slice(0, -1) + ABC[ABC.indexOf(k.fid[21]) ^ 1];
    const bad: Record<string, unknown> = {
      [nonCanonical]: fam('owner', 0, k.cur),
      [any().fid]: fam('', 0, any().cur),
      [any().fid]: fam('owner', 1.5, any().cur),
      [any().fid]: fam('owner', -1, any().cur),
      [any().fid]: fam('owner', 2 ** 32, any().cur),
      [any().fid]: fam('owner', 0, any().cur.slice(0, 42)),
      [any().fid]: fam('owner', 0, any().cur, { createdAt: null }),
      [any().fid]: fam('owner', 0, any().cur, { usedAt: '1000' }),
      [any().fid]: fam('owner', 0, any().cur, { legacy: 5 }),
    };
    expect(Object.keys(bad)).toHaveLength(9);
    seedFamilies(file, KEY, { ...bad, [good.fid]: fam('owner', 0, good.cur) });
    const r = s.rotate(good.token, 2000);
    expect(r!.sub).toBe('owner');
    expect(Object.keys(onDisk(file, KEY).families)).toEqual([good.fid]);
  });
});

describe('RefreshStore earlier-release records', () => {
  const KEY = 'master-key-for-test';
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const storeAt = () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gm-legacy-'));
    const file = path.join(dir, 'mcp-tokens.enc');
    const logs: string[] = [];
    return { s: new RefreshStore(file, KEY, { log: (l) => logs.push(l) }), file, logs };
  };
  const [L0, L1] = [legacyTok('L0'), legacyTok('L1')];

  it('M1 a live earlier-release token rotates once into a new family that keeps its evidence', () => {
    const { s, file } = storeAt();
    seedLegacy(file, KEY, { [L1]: { sub: 'owner', issuedAt: 1000, family: 'fam-a' } }, { [L0]: 'fam-a' });
    const r = s.rotate(L1, 2000);
    expect(r!.sub).toBe('owner');
    expect(r!.token).toMatch(/^r1\./);
    const d = onDisk(file, KEY);
    expect(d.format).toBe(2);
    expect(d.active).toEqual({});
    expect(d.spent).toEqual({ [L0]: 'fam-a', [L1]: 'fam-a' });
    expect(Object.values(d.families)).toEqual([expect.objectContaining({ sub: 'owner', gen: 0, createdAt: 1000, usedAt: 2000, legacy: 'fam-a' })]);
    expect(s.rotate(r!.token, 3000)!.sub).toBe('owner');
    expect(onDisk(file, KEY).spent).toEqual({ [L0]: 'fam-a', [L1]: 'fam-a' });
  });

  it('M2 an earlier-release rotated-away token revokes the family it migrated into', () => {
    for (const reused of [L0, L1]) {
      const { s, file, logs } = storeAt();
      seedLegacy(file, KEY, { [L1]: { sub: 'owner', issuedAt: 1000, family: 'fam-a' } }, { [L0]: 'fam-a' });
      const r = s.rotate(L1, 2000)!;
      expect(s.rotate(reused, 3000)).toBeNull();
      expect(s.rotate(r.token, 3001)).toBeNull();
      const d = onDisk(file, KEY);
      expect([d.families, d.active, d.spent]).toEqual([{}, {}, {}]);
      expect(logs).toEqual([`refresh family revoked: reuse tag=${specTag('fam-a')}`]);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('M3 nothing is evicted: the oldest of 2,001 earlier-release tokens still revokes after 20 new rotations', () => {
    const { s, file } = storeAt();
    const spent: Record<string, string> = {};
    for (let i = 0; i < 2000; i++) spent[legacyTok(`s${i}`)] = 'fam-a';
    seedLegacy(file, KEY, { [L1]: { sub: 'owner', issuedAt: 1000, family: 'fam-a' } }, spent);
    let t = s.rotate(L1, 2000)!.token;
    for (let i = 0; i < 20; i++) t = s.rotate(t, 3000 + i)!.token;
    expect(Object.keys(onDisk(file, KEY).spent)).toHaveLength(2001);
    expect(s.rotate(legacyTok('s0'), 9000)).toBeNull();
    expect(s.rotate(t, 9001)).toBeNull();
  });

  it('M5 accept false on an earlier-release token drops every session of that subject in both formats', () => {
    const { s, file } = storeAt();
    const [La, Lb] = [legacyTok('La'), legacyTok('Lb')];
    seedLegacy(file, KEY, { [La]: { sub: 'tenant-a', issuedAt: 1000, family: 'fam-a' }, [Lb]: { sub: 'tenant-b', issuedAt: 1000, family: 'fam-b' } }, { [L0]: 'fam-a' });
    const r1a = s.issue(1500, 'tenant-a');
    expect(s.rotate(La, 2000, (sub) => sub !== 'tenant-a')).toBeNull();
    const d = onDisk(file, KEY);
    expect(d.families).toEqual({});
    expect(Object.keys(d.active)).toEqual([Lb]);
    expect(d.spent).toEqual({});
    expect(s.rotate(r1a, 3000)).toBeNull();
    expect(s.rotate(Lb, 3001, () => true)!.sub).toBe('tenant-b');
  });

  it('M6 purgeTenant counts and drops sessions in both formats and their evidence', () => {
    const { s, file } = storeAt();
    seedLegacy(file, KEY, { [L1]: { sub: 'tenant-a', issuedAt: 1000, family: 'fam-a' } }, { [L0]: 'fam-a' });
    s.issue(1500, 'tenant-a');
    s.issue(1500, 'tenant-a');
    const b = s.issue(1500, 'tenant-b');
    expect(s.purgeTenant('tenant-a')).toBe(3);
    const d = onDisk(file, KEY);
    expect(d.active).toEqual({});
    expect(d.spent).toEqual({});
    expect(Object.values(d.families).map((f) => f.sub)).toEqual(['tenant-b']);
    expect(s.rotate(b, 2000)!.sub).toBe('tenant-b');
  });

  it('M9 round trip with the previous release: it refuses new tokens, and its file loads back', () => {
    const { file } = storeAt();
    const next = new RefreshStore(file, KEY);
    const a = next.rotate(next.issue(1000, 'tenant-a'), 2000)!.token;
    const d = onDisk(file, KEY);
    const Lb = legacyTok('Lb');
    writeFileSync(file, encryptToken({ ...d, active: { [Lb]: { sub: 'tenant-b', issuedAt: 1000, family: 'fam-b' } } }, KEY), { mode: 0o600 });

    const prev = new PrevRefreshStore(file, KEY);
    const before = readFileSync(file);
    expect(prev.rotate(a, 3000)).toBeNull();
    expect(readFileSync(file).equals(before)).toBe(true);
    const c = prev.issue(3000, 'tenant-c');
    const written = onDisk(file, KEY);
    expect('families' in written || 'format' in written).toBe(false);
    expect(Object.keys(written.active).sort()).toEqual([Lb, c].sort());

    const upgraded = new RefreshStore(file, KEY);
    expect(upgraded.rotate(a, 4000)).toBeNull();
    const rb = upgraded.rotate(Lb, 4001)!;
    const rc = upgraded.rotate(c, 4002)!;
    expect([rb.sub, rc.sub]).toEqual(['tenant-b', 'tenant-c']);
    expect(rb.token).toMatch(/^r1\./);
    expect(upgraded.rotate(rc.token, 4003)!.sub).toBe('tenant-c');
  });
});

describe('RefreshStore lifetimes (ruling 10)', () => {
  const KEY = 'master-key-for-test';
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const storeAt = (options: RefreshStoreOptions = {}) => {
    dir = mkdtempSync(path.join(tmpdir(), 'gm-life-'));
    const file = path.join(dir, 'mcp-tokens.enc');
    const logs: string[] = [];
    return { s: new RefreshStore(file, KEY, { log: (l) => logs.push(l), ...options }), file, logs };
  };
  const subsOnDisk = (file: string) => Object.values(onDisk(file, KEY).families).map((f) => f.sub).sort();
  const unknownFamily = () => specToken(KEY, randomBytes(16), 0).token;

  it('L1 maxAgeSec ends a family that long after its sign-in, however often it rotates', () => {
    const { s, file } = storeAt({ maxAgeSec: 100 });
    let t = s.issue(0, 'owner');
    t = s.rotate(t, 50_000)!.token;
    t = s.rotate(t, 99_999)!.token;
    expect(s.rotate(t, 100_000)).toBeNull();
    expect(onDisk(file, KEY).families).toEqual({});
  });

  it('L2 idleSec ends a family that long after its last rotation', () => {
    const { s, file } = storeAt({ idleSec: 10 });
    let t = s.issue(0, 'owner');
    t = s.rotate(t, 9_999)!.token;
    t = s.rotate(t, 19_998)!.token;
    expect(s.rotate(t, 29_998)).toBeNull();
    expect(onDisk(file, KEY).families).toEqual({});
  });

  it('L3 without options a family never expires', () => {
    const { s } = storeAt();
    const t = s.issue(0, 'owner');
    expect(s.rotate(t, 10 * 365 * 86_400_000)!.sub).toBe('owner');
  });

  it('L4 every issue and rotation drops the expired families of every subject', () => {
    const { s, file } = storeAt({ idleSec: 10 });
    s.issue(0, 'a');
    const b = s.issue(0, 'b');
    s.issue(0, 'c');
    s.rotate(b, 5_000);
    s.issue(12_000, 'd');
    expect(subsOnDisk(file)).toEqual(['b', 'd']);
  });

  it('L5 a refused token writes only when the prune found work', () => {
    const { s, file } = storeAt({ idleSec: 10 });
    s.issue(0, 'a');
    s.issue(0, 'b');
    const before = readFileSync(file);
    expect(s.rotate(unknownFamily(), 30_000)).toBeNull();
    const pruned = readFileSync(file);
    expect(pruned.equals(before)).toBe(false);
    expect(onDisk(file, KEY).families).toEqual({});
    expect(s.rotate(unknownFamily(), 30_001)).toBeNull();
    expect(s.rotate('x'.repeat(60), 30_002)).toBeNull();
    expect(readFileSync(file).equals(pruned)).toBe(true);
  });

  it('L6 an expired family is refused without consulting accept', () => {
    const { s } = storeAt({ idleSec: 10 });
    const t = s.issue(0, 'owner');
    const accept = vi.fn(() => true);
    expect(s.rotate(t, 10_000, accept)).toBeNull();
    expect(accept).not.toHaveBeenCalled();
  });

  it('L7 a throwing accept writes and logs nothing, not even the prune; the retry logs the expiry once', () => {
    const { s, file, logs } = storeAt({ idleSec: 10 });
    s.issue(0, 'x');
    const y = s.issue(8_000, 'y');
    const before = readFileSync(file);
    expect(() =>
      s.rotate(y, 12_000, () => {
        throw new Error('registry unreadable');
      }),
    ).toThrow('registry unreadable');
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(logs).toEqual([]);
    expect(s.rotate(y, 12_001, () => true)!.sub).toBe('y');
    expect(logs).toEqual(['refresh families expired n=1']);
  });

  it('L8 a lifetime that is not a positive whole number throws', () => {
    for (const name of ['maxAgeSec', 'idleSec'] as const) {
      for (const bad of [0, -1, 1.5, NaN, Infinity, '10']) {
        expect(() => new RefreshStore('/unused', KEY, { [name]: bad as number }), `${name}=${String(bad)}`).toThrow(`E_REFRESH_OPTION_INVALID: ${name} must be a positive whole number`);
      }
    }
  });

  it('L9 an idle limit longer than the absolute one is allowed and the absolute one still fires', () => {
    const { s } = storeAt({ maxAgeSec: 100, idleSec: 1000 });
    let t = s.issue(0, 'owner');
    t = s.rotate(t, 50_000)!.token;
    expect(s.rotate(t, 100_000)).toBeNull();
  });

  it('T1 the last-use time never moves backwards', () => {
    const { s, file } = storeAt({ idleSec: 100 });
    let t = s.issue(0, 'owner');
    t = s.rotate(t, 10_000)!.token;
    s.rotate(t, 5_000);
    expect(Object.values(onDisk(file, KEY).families)[0].usedAt).toBe(10_000);
  });

  it('T2 a time written while the clock ran ahead is pulled back, so the limit counts from the clock', () => {
    const { s, file, logs } = storeAt({ maxAgeSec: 100 });
    const t0 = 1_000_000_000;
    const ahead = specToken(KEY, randomBytes(16), 0);
    seedFamilies(file, KEY, { [ahead.fid]: { sub: 'a', gen: 0, cur: ahead.cur, createdAt: t0 + 1e9, usedAt: t0 + 1e9 } });
    expect(s.rotate(unknownFamily(), t0)).toBeNull();
    expect(onDisk(file, KEY).families[ahead.fid]).toMatchObject({ createdAt: t0, usedAt: t0 });
    expect(logs).toEqual(['refresh store clock: n=2 timestamps ahead of the clock were clamped']);
    expect(s.rotate(ahead.token, t0 + 100_000)).toBeNull();
  });

  it('T3 a prune that empties the store says the clock may be wrong', () => {
    let { s, logs } = storeAt({ idleSec: 10 });
    s.issue(0, 'a');
    s.issue(0, 'b');
    s.rotate(unknownFamily(), 50_000);
    expect(logs).toEqual(['refresh families expired n=2', 'refresh store: every session expired at once (check the host clock)']);
    rmSync(dir, { recursive: true, force: true });
    ({ s, logs } = storeAt({ idleSec: 10 }));
    s.issue(40_000, 'a');
    s.issue(45_000, 'b');
    s.rotate(unknownFamily(), 50_000);
    expect(logs).toEqual(['refresh families expired n=1']);
  });

  it('M4 earlier-release sessions expire too, and a migrated one keeps its original sign-in time', () => {
    let { s, file } = storeAt({ idleSec: 10 });
    const [L0, L1] = [legacyTok('L0'), legacyTok('L1')];
    seedLegacy(file, KEY, { [L1]: { sub: 'owner', issuedAt: 1000, family: 'fam-a' } }, { [L0]: 'fam-a' });
    expect(s.rotate(L1, 11_000)).toBeNull();
    const d = onDisk(file, KEY);
    expect([d.families, d.active, d.spent]).toEqual([{}, {}, {}]);
    rmSync(dir, { recursive: true, force: true });
    ({ s, file } = storeAt({ maxAgeSec: 100 }));
    seedLegacy(file, KEY, { [L1]: { sub: 'owner', issuedAt: 1000, family: 'fam-a' } });
    const r = s.rotate(L1, 50_000)!;
    expect(s.rotate(r.token, 101_000)).toBeNull();
  });
});

describe('RefreshStore pre-auth cost', () => {
  const KEY = 'master-key-for-test';
  let dir: string;
  let clock = 0;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const storeAt = () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gm-prelock-'));
    const file = path.join(dir, 'mcp-tokens.enc');
    return { s: new RefreshStore(file, KEY), file };
  };
  // The lock is not re-entrant, so a call that takes it while this test holds
  // it waits out LOCK_TIMEOUT_MS; the fast clock makes that quick.
  const fastClock = () => {
    clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 500));
  };

  it('P1 a malformed or forged token is refused without taking the lock or touching the directory', () => {
    const { s, file } = storeAt();
    const t = s.issue(1000, 'owner');
    const forged = specToken(KEY, r1Bytes(t).subarray(0, 16), 0, { mac: randomBytes(32) }).token;
    fastClock();
    withFileLock(file, () => {
      const bytes = readFileSync(file);
      const listing = readdirSync(dir).sort();
      for (const x of [forged, 'x'.repeat(60), `r1.${'*'.repeat(91)}`, 'constructor']) {
        expect(() => s.rotate(x, 2000)).not.toThrow();
        expect(s.rotate(x, 2000)).toBeNull();
      }
      expect(readFileSync(file).equals(bytes)).toBe(true);
      expect(readdirSync(dir).sort()).toEqual(listing);
    });
  });

  it('P2 an earlier-release-shaped token skips the lock once the store holds no earlier-release record', () => {
    const { s, file } = storeAt();
    s.issue(1000, 'owner');
    fastClock();
    withFileLock(file, () => expect(s.rotate(legacyTok('junk'), 2000)).toBeNull());
    vi.restoreAllMocks();

    const other = storeAt();
    seedLegacy(other.file, KEY, { [legacyTok('L1')]: { sub: 'owner', issuedAt: 1000, family: 'fam-a' } });
    other.s.issue(1000, 'owner');
    fastClock();
    expect(() => withFileLock(other.file, () => other.s.rotate(legacyTok('junk'), 2000))).toThrow(/Timed out/);
  });

  it('P4 a failed read does not turn on the pre-lock refusal', () => {
    const { s, file } = storeAt();
    const L1 = legacyTok('L1');
    seedLegacy(file, KEY, { [L1]: { sub: 'owner', issuedAt: 1000, family: 'fam-a' } });
    const bytes = readFileSync(file);
    writeFileSync(file, 'not a store');
    expect(s.purgeTenant('nobody')).toBe(0);
    writeFileSync(file, bytes);
    expect(s.rotate(L1, 2000)?.sub).toBe('owner');
  });

  it('P3 refreshFamilyTagger tags a family the same at every generation and nothing else', () => {
    const { s } = storeAt();
    const tag = refreshFamilyTagger(KEY);
    const a0 = s.issue(1000, 'owner');
    const a1 = s.rotate(a0, 2000)!.token;
    const b = s.issue(1000, 'owner');
    expect(tag(a0)).toBe(specTag(r1Bytes(a0).subarray(0, 16)));
    expect(tag(a1)).toBe(tag(a0));
    expect(tag(b)).not.toBe(tag(a0));
    expect(tag(b)).toMatch(/^[0-9a-f]{8}$/);
    const badMac = specToken(KEY, r1Bytes(a0).subarray(0, 16), 0, { mac: randomBytes(32) }).token;
    for (const x of [badMac, legacyTok('L1'), 'garbage', '']) expect(tag(x)).toBeNull();
    expect(refreshFamilyTagger('another-master-key')(a0)).toBeNull();
  });
});

describe('signed alias_reauth link', () => {
  const secret = jwtSecretFrom('reauth-link-test-key');
  const base = 'https://mcp.test';
  const parse = (q: string) => {
    const p = new URLSearchParams(q);
    return { alias: p.get('alias') ?? '', exp: p.get('exp') ?? '', sig: p.get('sig') ?? '' };
  };
  const now = 1_800_000_000;

  it('round-trips the alias until it expires', () => {
    const link = parse(signReauthLink(base, secret, 'work', now));
    expect(verifyReauthLink(base, secret, link, now)).toBe('work');
    expect(verifyReauthLink(base, secret, link, now + REAUTH_LINK_TTL_SEC)).toBe('work');
    expect(verifyReauthLink(base, secret, link, now + REAUTH_LINK_TTL_SEC + 1)).toBeNull();
  });

  it('refuses a changed alias, a stretched expiry, another server, another key or a mangled signature', () => {
    const link = parse(signReauthLink(base, secret, 'work', now));
    expect(verifyReauthLink(base, secret, { ...link, alias: 'other' }, now)).toBeNull();
    expect(verifyReauthLink(base, secret, { ...link, exp: String(Number(link.exp) + 3600) }, now)).toBeNull();
    expect(verifyReauthLink('https://other.test', secret, link, now)).toBeNull();
    expect(verifyReauthLink(base, jwtSecretFrom('another-key'), link, now)).toBeNull();
    expect(verifyReauthLink(base, secret, { ...link, sig: link.sig.slice(0, -2) }, now)).toBeNull();
    expect(verifyReauthLink(base, secret, { ...link, sig: '' }, now)).toBeNull();
    expect(verifyReauthLink(base, secret, { ...link, exp: `${link.exp}.5` }, now)).toBeNull();
    expect(verifyReauthLink(base, secret, { ...link, alias: '' }, now)).toBeNull();
  });
});
