import { describe, it, expect, afterEach } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  jwtSecretFrom,
  signAccessToken,
  verifyAccessToken,
  signState,
  verifyState,
  signAuthzCode,
  verifyAuthzCode,
  ReplayGuard,
  RefreshStore,
  type StatePayload,
} from '../src/mcp-token.js';

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
