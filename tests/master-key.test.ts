import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveMasterKey, resolveJwtKey, peekMasterKeyProvenance, clearKeyCacheForTest, noteSuccessfulDecrypt, __setKeychainFactoryForTest } from '../src/master-key.js';

let dir: string;

const fakeKeychain = (store: Map<string, string>, available = true) =>
  (account: string) =>
    available
      ? {
          get: () => store.get(account) ?? null,
          set: (v: string) => void store.set(account, v),
          del: () => void store.delete(account),
        }
      : null;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mkey-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('resolveMasterKey precedence (BR-2)', () => {
  it('env wins over keychain and file, trimmed', () => {
    const store = new Map([['MASTER_KEY', 'from-keychain']]);
    writeFileSync(path.join(dir, 'master.key'), 'from-file\n');
    const r = resolveMasterKey({
      env: { MASTER_KEY: '  from-env  ' } as NodeJS.ProcessEnv,
      dir,
      keychain: fakeKeychain(store),
      hasAnyToken: () => false,
    });
    expect(r).toEqual({ key: 'from-env', provenance: 'env' });
  });

  it('keychain beats file', () => {
    const store = new Map([['MASTER_KEY', 'from-keychain']]);
    writeFileSync(path.join(dir, 'master.key'), 'from-file\n');
    const r = resolveMasterKey({ env: {} as NodeJS.ProcessEnv, dir, keychain: fakeKeychain(store), hasAnyToken: () => false });
    expect(r).toEqual({ key: 'from-keychain', provenance: 'keychain' });
  });

  it('file is the fallback when the keychain backend is unavailable', () => {
    writeFileSync(path.join(dir, 'master.key'), 'from-file\n', { mode: 0o600 });
    const r = resolveMasterKey({
      env: {} as NodeJS.ProcessEnv,
      dir,
      keychain: fakeKeychain(new Map(), false),
      hasAnyToken: () => false,
    });
    expect(r).toEqual({ key: 'from-file', provenance: 'file' });
  });

  it.skipIf(process.platform === 'win32')('warns when the key file is readable by others', () => {
    const p = path.join(dir, 'master.key');
    writeFileSync(p, 'k\n');
    chmodSync(p, 0o644);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    resolveMasterKey({ env: {} as NodeJS.ProcessEnv, dir, keychain: fakeKeychain(new Map(), false), hasAnyToken: () => false });
    expect(stderr.mock.calls.some((c) => String(c[0]).includes('chmod 600'))).toBe(true);
  });
});

describe('generate-on-setup (BR-4)', () => {
  it('generates a 32-byte base64 key, ALWAYS writes the durable file, and copies to the keychain', () => {
    const store = new Map<string, string>();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const r = resolveMasterKey({ env: {} as NodeJS.ProcessEnv, dir, keychain: fakeKeychain(store), hasAnyToken: () => false });
    expect(r.provenance).toBe('generated');
    expect(Buffer.from(r.key, 'base64')).toHaveLength(32);
    expect(store.get('MASTER_KEY')).toBe(r.key);
    // The kernel-keyutils "keychain" on Linux is volatile: the 0600 file is
    // the durable sink and must exist even when the keychain write succeeded.
    expect(readFileSync(path.join(dir, 'master.key'), 'utf8').trim()).toBe(r.key);
    expect(stderr.mock.calls.some((c) => String(c[0]).includes('master.key'))).toBe(true);
  });

  it('falls back to a 0600 file when the keychain is unavailable', () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const r = resolveMasterKey({
      env: {} as NodeJS.ProcessEnv,
      dir,
      keychain: fakeKeychain(new Map(), false),
      hasAnyToken: () => false,
    });
    expect(r.provenance).toBe('generated');
    const p = path.join(dir, 'master.key');
    expect(readFileSync(p, 'utf8').trim()).toBe(r.key);
    if (process.platform !== 'win32') expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('removes a keychain entry that does not read back byte-exact (it would shadow the file)', () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let wrote = false;
    let deleted = false;
    const lying = {
      get: () => (wrote && !deleted ? 'tampered' : null),
      set: () => {
        wrote = true;
      },
      del: () => {
        deleted = true;
      },
    };
    const r = resolveMasterKey({
      env: {} as NodeJS.ProcessEnv,
      dir,
      keychain: () => lying,
      hasAnyToken: () => false,
    });
    expect(r.provenance).toBe('generated');
    expect(readFileSync(path.join(dir, 'master.key'), 'utf8').trim()).toBe(r.key);
    expect(deleted).toBe(true);
  });
});

describe('peekMasterKeyProvenance (diagnostics must be side-effect free)', () => {
  it('never generates: keyless install reports unprovisioned and mints nothing', () => {
    const store = new Map<string, string>();
    const prov = peekMasterKeyProvenance({ env: {} as NodeJS.ProcessEnv, dir, keychain: fakeKeychain(store) });
    expect(prov).toBe('unprovisioned');
    expect(store.size).toBe(0);
    expect(existsSync(path.join(dir, 'master.key'))).toBe(false);
  });

  it('reports the source without touching it', () => {
    writeFileSync(path.join(dir, 'master.key'), 'k\n', { mode: 0o600 });
    expect(
      peekMasterKeyProvenance({ env: {} as NodeJS.ProcessEnv, dir, keychain: fakeKeychain(new Map(), false) }),
    ).toBe('file');
  });
});

describe('BR-5 mirror (the path that once leaked a fixture key into a real keyring)', () => {
  afterEach(() => {
    clearKeyCacheForTest();
    __setKeychainFactoryForTest(null);
  });

  it('mirrors an env-sourced key into an empty keychain only after a successful decrypt', () => {
    const store = new Map<string, string>();
    __setKeychainFactoryForTest(fakeKeychain(store));
    clearKeyCacheForTest();
    const saved = process.env.MASTER_KEY;
    process.env.MASTER_KEY = 'env-key-value';
    try {
      resolveMasterKey({ env: process.env, dir, keychain: fakeKeychain(store), hasAnyToken: () => false });
      // deps form does not cache; resolve via production path to set the cache
      clearKeyCacheForTest();
      resolveMasterKeyProduction();
      expect(store.has('MASTER_KEY')).toBe(false);
      noteSuccessfulDecrypt();
      expect(store.get('MASTER_KEY')).toBe('env-key-value');
    } finally {
      if (saved === undefined) delete process.env.MASTER_KEY;
      else process.env.MASTER_KEY = saved;
    }
  });

  it('never overwrites an existing keychain entry', () => {
    const store = new Map<string, string>([['MASTER_KEY', 'existing']]);
    __setKeychainFactoryForTest(fakeKeychain(store));
    clearKeyCacheForTest();
    const saved = process.env.MASTER_KEY;
    process.env.MASTER_KEY = 'env-key-value';
    try {
      resolveMasterKeyProduction();
      noteSuccessfulDecrypt();
      expect(store.get('MASTER_KEY')).toBe('existing');
    } finally {
      if (saved === undefined) delete process.env.MASTER_KEY;
      else process.env.MASTER_KEY = saved;
    }
  });
});

function resolveMasterKeyProduction() {
  return resolveMasterKey();
}

describe('dispatch path never exits the process', () => {
  it('resolveMasterKeyForDispatch with tokens present and no key THROWS, never exits', async () => {
    const { resolveMasterKeyForDispatch } = await import('../src/master-key.js');
    __setKeychainFactoryForTest(fakeKeychain(new Map(), false));
    clearKeyCacheForTest();
    const saved = process.env.MASTER_KEY;
    delete process.env.MASTER_KEY;
    const exit = vi.spyOn(process, 'exit');
    try {
      const { mkdirSync } = await import('node:fs');
      const tokenDir = process.env.TOKEN_STORE_PATH!;
      mkdirSync(tokenDir, { recursive: true });
      writeFileSync(path.join(tokenDir, 'ghost.enc'), '{}');
      expect(() => resolveMasterKeyForDispatch()).toThrow(/E_MASTER_KEY_MISSING_TOKENS_EXIST/);
      expect(exit).not.toHaveBeenCalled();
      rmSync(path.join(tokenDir, 'ghost.enc'), { force: true });
    } finally {
      if (saved === undefined) delete process.env.MASTER_KEY;
      else process.env.MASTER_KEY = saved;
      clearKeyCacheForTest();
      __setKeychainFactoryForTest(null);
    }
  });
});

describe('hard guard token scan is recursive (S1.2 anti-brick)', () => {
  // These cases OMIT deps.hasAnyToken on purpose: they exercise the real
  // scanner against the sandboxed TOKEN_STORE_PATH / XDG_CONFIG_HOME dirs.
  const realScanDeps = () => ({
    env: {} as NodeJS.ProcessEnv,
    dir,
    keychain: fakeKeychain(new Map(), false),
  });

  const expectRefusal = (fn: () => unknown) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit-called');
    });
    expect(fn).toThrow('exit-called');
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('E_MASTER_KEY_MISSING_TOKENS_EXIST');
  };

  it('a flat .enc directly in the token dir still refuses to mint (superset of the old scan)', async () => {
    const { mkdirSync } = await import('node:fs');
    const tokenDir = process.env.TOKEN_STORE_PATH!;
    mkdirSync(tokenDir, { recursive: true });
    const enc = path.join(tokenDir, 'flat-guard.enc');
    writeFileSync(enc, '{}');
    try {
      expectRefusal(() => resolveMasterKey(realScanDeps()));
    } finally {
      rmSync(enc, { force: true });
    }
  });

  it('a NESTED .enc under the token dir refuses to mint (the flat scan missed it = brick)', async () => {
    const { mkdirSync } = await import('node:fs');
    const nested = path.join(process.env.TOKEN_STORE_PATH!, 'nested', 'deeper');
    mkdirSync(nested, { recursive: true });
    const enc = path.join(nested, 'alias.enc');
    writeFileSync(enc, '{}');
    try {
      expectRefusal(() => resolveMasterKey(realScanDeps()));
    } finally {
      rmSync(path.join(process.env.TOKEN_STORE_PATH!, 'nested'), { recursive: true, force: true });
    }
  });

  it('a tenant-namespaced .enc under configDir()/tenants refuses to mint (future S1.6 layout)', async () => {
    const { mkdirSync } = await import('node:fs');
    const tenantTokens = path.join(process.env.XDG_CONFIG_HOME!, 'mcp-google-multi', 'tenants', 'tenant-a', 'tokens');
    mkdirSync(tenantTokens, { recursive: true });
    const enc = path.join(tenantTokens, 'alias.enc');
    writeFileSync(enc, '{}');
    try {
      expectRefusal(() => resolveMasterKey(realScanDeps()));
    } finally {
      rmSync(path.join(process.env.XDG_CONFIG_HOME!, 'mcp-google-multi', 'tenants'), { recursive: true, force: true });
    }
  });

  it('a top-level .enc directly under configDir() refuses to mint (downstream tenant/invite registry beside tenants/)', async () => {
    const { mkdirSync } = await import('node:fs');
    const cfg = path.join(process.env.XDG_CONFIG_HOME!, 'mcp-google-multi');
    mkdirSync(cfg, { recursive: true });
    const enc = path.join(cfg, 'tenant-registry.enc');
    writeFileSync(enc, '{}');
    try {
      expectRefusal(() => resolveMasterKey(realScanDeps()));
    } finally {
      rmSync(enc, { force: true });
    }
  });

  it('non-.enc nested files (legacy plaintext token.json layout) do NOT trip the guard', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const { mkdirSync } = await import('node:fs');
    const legacy = path.join(process.env.TOKEN_STORE_PATH!, 'some-alias');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, 'token.json'), '{}');
    try {
      const r = resolveMasterKey(realScanDeps());
      expect(r.provenance).toBe('generated');
    } finally {
      rmSync(legacy, { recursive: true, force: true });
    }
  });
});

describe('hard guard (BR-3)', () => {
  it('never generates while encrypted tokens exist: E_MASTER_KEY_MISSING_TOKENS_EXIST', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit-called');
    });
    expect(() =>
      resolveMasterKey({ env: {} as NodeJS.ProcessEnv, dir, keychain: fakeKeychain(new Map(), false), hasAnyToken: () => true }),
    ).toThrow('exit-called');
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('E_MASTER_KEY_MISSING_TOKENS_EXIST');
    expect(existsSync(path.join(dir, 'master.key'))).toBe(false);
  });

  it('MCP_JWT_KEY has no hard guard: generates freely with tokens present', () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const r = resolveJwtKey({ env: {} as NodeJS.ProcessEnv, dir, keychain: fakeKeychain(new Map(), false), hasAnyToken: () => true });
    expect(r.provenance).toBe('generated');
    expect(readFileSync(path.join(dir, 'mcp-jwt.key'), 'utf8').trim()).toBe(r.key);
  });
});
