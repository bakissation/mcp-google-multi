import { describe, it, expect, afterEach } from 'vitest';
import { rmSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
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
  type StatePayload,
} from '../src/mcp-token.js';
import { decryptToken, encryptToken } from '../src/token-store.js';

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

describe('RefreshStore spent cap evicts from the subject holding the most (C3)', () => {
  const KEY = 'master-key-for-test';
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const storeAt = () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gm-spent-'));
    const file = path.join(dir, 'mcp-tokens.enc');
    return { s: new RefreshStore(file, KEY), file };
  };
  const onDisk = (file: string) => decryptToken(readFileSync(file, 'utf-8'), KEY) as unknown as {
    active: Record<string, { sub: string; family: string }>;
    spent: Record<string, string>;
  };
  const chain = (s: RefreshStore, token: string, n: number): string[] => {
    const out = [token];
    for (let i = 0; i < n; i++) out.push(s.rotate(out[out.length - 1], 2000 + i)!.token);
    return out;
  };
  // Each rotation is an fsynced write under the lock (minutes on NTFS for
  // thousands), so the history is written in the store's file shape, as a
  // chain of rotations leaves it, and only the rotations that cross the cap run.
  const seed = (file: string, families: [sub: string, spent: number][]): string[][] => {
    const active: Record<string, { sub: string; issuedAt: number; family: string }> = {};
    const spent: Record<string, string> = {};
    const chains = families.map(([sub, n], f) => {
      const family = `fam-${f}`;
      const t = Array.from({ length: n + 1 }, (_, i) => `tok-${f}-${i}`);
      for (const x of t.slice(0, n)) spent[x] = family;
      active[t[n]] = { sub, issuedAt: 1000, family };
      return t;
    });
    writeFileSync(file, encryptToken({ active, spent }, KEY), { mode: 0o600 });
    return chains;
  };
  const extend = (s: RefreshStore, t: string[], n: number): string[] => [...t, ...chain(s, t[t.length - 1], n).slice(1)];

  it('a subject opening many families dilutes only itself: another subject keeps its oldest stolen token armed', () => {
    const { s, file } = storeAt();
    const [v, ...att] = seed(file, [['victim', 600], ...Array.from({ length: 14 }, (): [string, number] => ['attacker', 100])]);
    const fresh = chain(s, s.issue(1000, 'attacker'), 20);
    // 2020 spent: the victim's are the oldest, yet the attacker holds the most and loses its 20 oldest.
    expect(Object.keys(onDisk(file).spent)).toEqual([
      ...v.slice(0, 600),
      ...att[0].slice(20, 100),
      ...att.slice(1).flatMap((t) => t.slice(0, 100)),
      ...fresh.slice(0, 20),
    ]);

    expect(s.rotate(v[0], 9000)).toBeNull();
    expect(s.rotate(v[600], 9001)).toBeNull();
    expect(s.rotate(att[0][19], 9002)).toBeNull();
    expect(s.rotate(att[0][100], 9003)!.sub).toBe('attacker');
  });

  it('a single subject keeps the last 2000 rotated-away tokens across its families, oldest first', () => {
    const { s, file } = storeAt();
    const [a, b0] = seed(file, [['owner', 800], ['owner', 1190]]);
    const b = extend(s, b0, 15);
    expect(Object.keys(onDisk(file).spent)).toEqual([...a.slice(5, 800), ...b.slice(0, 1205)]);

    expect(s.rotate(a[4], 9000)).toBeNull();
    expect(Object.keys(onDisk(file).active)).toEqual([a[800], b[1205]]);
    expect(s.rotate(a[5], 9001)).toBeNull();
    expect(Object.keys(onDisk(file).active)).toEqual([b[1205]]);
    expect(s.rotate(b[1205], 9002)!.sub).toBe('owner');
  });

  it('a single family keeps its last 2000 rotated-away tokens: an older one is refused without revoking', () => {
    const { s, file } = storeAt();
    const [t0] = seed(file, [['owner', 1999]]);
    const t = extend(s, t0, 2);
    expect(Object.keys(onDisk(file).spent)).toEqual(t.slice(1, 2001));
    expect(s.rotate(t[0], 9000)).toBeNull();
    expect(Object.keys(onDisk(file).active)).toEqual([t[2001]]);
    expect(s.rotate(t[1], 9001)).toBeNull();
    expect(s.rotate(t[2001], 9002)).toBeNull();
  });

  it('three subjects over the cap: the largest loses its oldest across its families, ties to the oldest entry', () => {
    const { s, file } = storeAt();
    const [a1, a2, b, c0] = seed(file, [['tenant-a', 700], ['tenant-a', 500], ['tenant-b', 800], ['tenant-c', 596]]);
    const c = extend(s, c0, 5);
    // 400 from a (1200 -> 800), then a and b alternately, a first as its oldest
    // entry is older; c never holds the most. Each keeps at least floor(2000 / 3).
    expect(Object.keys(onDisk(file).spent)).toEqual([
      ...a1.slice(501, 700),
      ...a2.slice(0, 500),
      ...b.slice(100, 800),
      ...c.slice(0, 601),
    ]);

    expect(s.rotate(a1[500], 9000)).toBeNull();
    expect(s.rotate(b[99], 9001)).toBeNull();
    expect(Object.keys(onDisk(file).active)).toEqual([a1[700], a2[500], b[800], c[601]]);
    expect(s.rotate(a1[501], 9002)).toBeNull();
    expect(s.rotate(c[0], 9003)).toBeNull();
    expect(s.rotate(a1[700], 9004)).toBeNull();
    expect(s.rotate(c[601], 9005)).toBeNull();
    expect(s.rotate(a2[500], 9006)!.sub).toBe('tenant-a');
    expect(s.rotate(b[800], 9007)!.sub).toBe('tenant-b');
  });

  it('a family with no active token left keeps no spent tokens: revoked, refused by accept, or purged', () => {
    const { s, file } = storeAt();
    const familyOf = (token: string) => onDisk(file).active[token].family;
    const a = chain(s, s.issue(1000, 'tenant-a'), 2);
    const a2 = chain(s, s.issue(1000, 'tenant-a'), 2);
    const b = chain(s, s.issue(1000, 'tenant-b'), 2);
    const c = chain(s, s.issue(1000, 'tenant-c'), 2);
    const d = chain(s, s.issue(1000, 'tenant-d'), 2);
    const families = () => new Set(Object.values(onDisk(file).spent));
    const [fa, fa2, fb, fc, fd] = [a, a2, b, c, d].map((t) => familyOf(t[2]));
    expect(families()).toEqual(new Set([fa, fa2, fb, fc, fd]));

    expect(s.rotate(a[0], 9000)).toBeNull();
    expect(families()).toEqual(new Set([fa2, fb, fc, fd]));
    expect(s.rotate(b[2], 9001, () => false)).toBeNull();
    expect(families()).toEqual(new Set([fa2, fc, fd]));
    expect(s.purgeTenant('tenant-c')).toBe(1);
    expect(families()).toEqual(new Set([fa2, fd]));

    expect(s.rotate(a[1], 9002)).toBeNull();
    expect(s.rotate(c[1], 9003)).toBeNull();
    expect(s.rotate(a2[0], 9004)).toBeNull();
    expect(s.rotate(a2[2], 9005)).toBeNull();
    expect(s.rotate(d[2], 9006)!.sub).toBe('tenant-d');
  });

  it('loads a store written by an earlier release: the file shape is unchanged', () => {
    const { s, file } = storeAt();
    const active = {
      'a-live': { sub: 'tenant-a', issuedAt: 1000, family: 'fam-a' },
      'b-live': { sub: 'tenant-b', issuedAt: 1000, family: 'fam-b' },
    };
    const spent: Record<string, string> = { 'a-old': 'fam-a' };
    for (let i = 0; i < 100; i++) spent[`b-old-${i}`] = 'fam-b';
    spent['gone-old'] = 'fam-gone';
    writeFileSync(file, encryptToken({ active, spent }, KEY), { mode: 0o600 });

    expect(s.rotate('a-old', 9000)).toBeNull();
    expect(s.rotate('a-live', 9001)).toBeNull();
    const after = onDisk(file);
    expect(Object.keys(after.active)).toEqual(['b-live']);
    expect(after.spent).toEqual(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`b-old-${i}`, 'fam-b'])));
    expect(s.rotate('b-old-0', 9002)).toBeNull();
    expect(s.rotate('b-live', 9003)).toBeNull();
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
