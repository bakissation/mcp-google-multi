import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeGetClient, getClient, __inflightSizeForTest, type GetClientDeps } from '../src/client.js';
import { createTokenStore, writeToken } from '../src/token-store.js';
import { clearKeyCacheForTest } from '../src/master-key.js';
import type { AccountSet, Account } from '../src/accounts.js';

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'MASTER_KEY']) savedEnv[k] = process.env[k];
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  clearKeyCacheForTest();
});

const setOf = (aliases: string[]): AccountSet =>
  ({
    aliases,
    configs: Object.fromEntries(
      aliases.map((a) => [a, { email: `${a}@x.example`, tokenPath: `/x/${a}/token.json`, encPath: `/x/${a}.enc`, source: 'env' as const }]),
    ),
    scopeProfiles: { base: { bundles: [] } },
    source: 'env',
    stamp: 'env:0',
  }) as AccountSet;

function depsFor(aliases: string[], tokens: Record<string, object | null>, counters = { reads: 0 }): GetClientDeps & { counters: { reads: number } } {
  return {
    accounts: () => setOf(aliases),
    readToken: (a: string) => {
      counters.reads += 1;
      return (tokens[a] ?? null) as never;
    },
    updateToken: () => undefined,
    counters,
  };
}

describe('makeGetClient (S1.7 factory + single-flight)', () => {
  it('same-tick callers share ONE in-flight client; sequential callers get fresh ones', async () => {
    const d = depsFor(['work'], { work: { refresh_token: 'rt-1' } });
    const fn = makeGetClient('ctx-a', d);
    const p1 = fn('work' as Account);
    const p2 = fn('work' as Account);
    expect(p2).toBe(p1); // deduped while in flight
    const c1 = await p1;
    expect(d.counters.reads).toBe(1); // one token read for the burst
    const c2 = await fn('work' as Account);
    expect(c2).not.toBe(c1); // fresh client per call once settled
    expect(d.counters.reads).toBe(2);
    expect(__inflightSizeForTest()).toBe(0);
  });

  it('a rejected construction leaves the map clean and keeps the tagged slugs', async () => {
    const d = depsFor(['work'], { work: null });
    const fn = makeGetClient('ctx-err', d);
    await expect(fn('work' as Account)).rejects.toMatchObject({ code: 'E_NO_TOKEN' });
    await expect(fn('nope' as Account)).rejects.toMatchObject({ code: 'E_UNKNOWN_ACCOUNT' });
    delete process.env.GOOGLE_CLIENT_ID;
    await expect(fn('work' as Account)).rejects.toMatchObject({ code: 'E_NO_OAUTH_CLIENT' });
    // let the settle handlers run, then the lane must be empty
    await Promise.resolve();
    expect(__inflightSizeForTest()).toBe(0);
  });

  it('cross-context isolation: the same alias under two contexts never shares a client or a token (#358 shape)', async () => {
    const dA = depsFor(['work'], { work: { refresh_token: 'rt-tenant-a' } });
    const dB = depsFor(['work'], { work: { refresh_token: 'rt-tenant-b' } });
    const fnA = makeGetClient('tenant-a', dA);
    const fnB = makeGetClient('tenant-b', dB);
    const pA = fnA('work' as Account);
    const pB = fnB('work' as Account);
    expect(pB).not.toBe(pA); // distinct single-flight lanes
    const [cA, cB] = await Promise.all([pA, pB]);
    expect(cA.credentials.refresh_token).toBe('rt-tenant-a');
    expect(cB.credentials.refresh_token).toBe('rt-tenant-b');
  });

  it('the bare getClient export still resolves against the global registry (operator/CLI path)', async () => {
    process.env.MASTER_KEY = 'client-test-master-key';
    clearKeyCacheForTest();
    writeToken('test', { refresh_token: 'rt-global' });
    const c = await getClient('test' as Account);
    expect(c.credentials.refresh_token).toBe('rt-global');
  });
});

describe('createTokenStore (S1.7 custody closures)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-store-'));
    dirs.push(d);
    return d;
  };

  it('round-trips per tenant; a foreign tenant ciphertext under the same alias refuses to decrypt', () => {
    const dirA = tmp();
    const dirB = tmp();
    const storeA = createTokenStore(dirA, { tenantId: 'tenant-a', resolveKey: () => 'shared-master' });
    const storeB = createTokenStore(dirB, { tenantId: 'tenant-b', resolveKey: () => 'shared-master' });
    storeA.writeToken('work', { refresh_token: 'rt-a' });
    storeB.writeToken('work', { refresh_token: 'rt-b' });
    expect(storeA.readToken('work')).toMatchObject({ refresh_token: 'rt-a' });
    expect(storeB.readToken('work')).toMatchObject({ refresh_token: 'rt-b' });
    // simulate a mis-resolved path: B's file dropped into A's dir still cannot
    // decrypt under A's subkey — custody isolation is cryptographic, not just
    // directory layout
    fs.copyFileSync(path.join(dirB, 'work.enc'), path.join(dirA, 'work.enc'));
    expect(() => storeA.readToken('work')).toThrow();
  });

  it('updateToken merges through the store boundary and hasToken tracks the file', () => {
    const store = createTokenStore(tmp(), { tenantId: 'tenant-a', resolveKey: () => 'k' });
    expect(store.hasToken('work')).toBe(false);
    store.writeToken('work', { refresh_token: 'rt', scope: 's' });
    store.updateToken('work', { access_token: 'at', scope: undefined });
    expect(store.readToken('work')).toMatchObject({ refresh_token: 'rt', scope: 's', access_token: 'at' });
    expect(store.hasToken('work')).toBe(true);
  });

  it('rejects a traversal-shaped alias before touching the filesystem', () => {
    const store = createTokenStore(tmp(), { resolveKey: () => 'k' });
    for (const bad of ['../evil', 'a/b', '__proto__']) {
      expect(() => store.readToken(bad)).toThrow(/Invalid alias/);
    }
  });
});
