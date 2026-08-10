import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveAccounts } from '../src/accounts.js';
import { ConfigFileError } from '../src/config-file.js';
import { loadConfigFile, mutateConfigFile, CONFIG_VERSION } from '../src/config-file.js';
import { atomicWriteWithLock, withFileLock } from '../src/fs-atomic.js';
import { runMigrateConfig } from '../src/migrate-config.js';

let base: string;
let cfgPath: string;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'cfgreg-'));
  cfgPath = path.join(base, 'config.json');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const spyExit = () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit-called');
  });
  return { stderr, exit };
};

describe('resolveAccounts', () => {
  it('BR-2: non-empty GOOGLE_ACCOUNTS takes the whole registry from env', () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({ version: 1, accounts: { fileacct: { email: 'f@x.com' } } }),
    );
    const set = resolveAccounts({ GOOGLE_ACCOUNTS: 'work:w@x.com' } as NodeJS.ProcessEnv, cfgPath);
    expect(set.source).toBe('env');
    expect(set.aliases).toEqual(['work']);
    expect(set.configs.work.source).toBe('env');
  });

  it('loads the registry from config.json when env is unset', () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 1,
        accounts: { work: { email: 'w@x.com', scopeProfile: 'base' }, pers: { email: 'p@x.com', admin: true } },
      }),
    );
    const set = resolveAccounts({} as NodeJS.ProcessEnv, cfgPath);
    expect(set.source).toBe('file');
    expect(set.aliases).toEqual(['work', 'pers']);
    expect(set.configs.work.scopeProfile).toBe('base');
    expect(set.configs.pers.admin).toBe(true);
    expect(set.configs.work.source).toBe('config');
    expect(set.configs.work.encPath.endsWith('work.enc')).toBe(true);
    expect(set.stamp).toMatch(/^1:/);
  });

  it('GOOGLE_ADMIN_ACCOUNTS env overrides file admin flags when set', () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({ version: 1, accounts: { a: { email: 'a@x.com', admin: true }, b: { email: 'b@x.com' } } }),
    );
    const set = resolveAccounts({ GOOGLE_ADMIN_ACCOUNTS: 'b' } as NodeJS.ProcessEnv, cfgPath);
    expect(set.configs.a.admin).toBe(false);
    expect(set.configs.b.admin).toBe(true);
  });

  it('E_NO_ACCOUNTS_CONFIGURED: neither env nor file refuses to start', () => {
    const { stderr } = spyExit();
    expect(() => resolveAccounts({} as NodeJS.ProcessEnv, cfgPath)).toThrow('exit-called');
    expect(String(stderr.mock.calls[0]?.[0])).toContain('E_NO_ACCOUNTS_CONFIGURED');
    expect(String(stderr.mock.calls[0]?.[0])).toContain('migrate-config');
  });

  it('first-run shim materializes config.json from env, and only once', () => {
    const env = { GOOGLE_ACCOUNTS: 'work:w@x.com,ops:o@x.com', GOOGLE_ADMIN_ACCOUNTS: 'ops' } as NodeJS.ProcessEnv;
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    resolveAccounts(env, cfgPath);
    expect(existsSync(cfgPath)).toBe(true);
    const written = JSON.parse(readFileSync(cfgPath, 'utf8'));
    expect(written).toEqual({
      version: CONFIG_VERSION,
      accounts: { work: { email: 'w@x.com' }, ops: { email: 'o@x.com', admin: true } },
    });
    // 0o600 is ACL-wise a no-op on Windows (mode reads 0o666 there).
    if (process.platform !== 'win32') expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
    const mtime = statSync(cfgPath).mtimeMs;
    resolveAccounts(env, cfgPath);
    expect(statSync(cfgPath).mtimeMs).toBe(mtime);
  });

  it('keeps the v5 guards on env entries', () => {
    expect(() => resolveAccounts({ GOOGLE_ACCOUNTS: 'bad entry' } as NodeJS.ProcessEnv, cfgPath)).toThrow(
      'Expected format: alias:email',
    );
    expect(() => resolveAccounts({ GOOGLE_ACCOUNTS: '../evil:e@x.com' } as NodeJS.ProcessEnv, cfgPath)).toThrow(
      'Allowed characters',
    );
    expect(() => resolveAccounts({ GOOGLE_ACCOUNTS: 'a:1@x.com,a:2@x.com' } as NodeJS.ProcessEnv, cfgPath)).toThrow(
      'Duplicate alias',
    );
  });
});

describe('loadConfigFile', () => {
  it('returns null when the file does not exist', () => {
    expect(loadConfigFile(cfgPath)).toBeNull();
  });

  it('E_CONFIG_INVALID on malformed JSON', () => {
    writeFileSync(cfgPath, '{nope');
    const { stderr } = spyExit();
    expect(() => loadConfigFile(cfgPath)).toThrow('exit-called');
    expect(String(stderr.mock.calls[0]?.[0])).toContain('E_CONFIG_INVALID');
  });

  it('E_CONFIG_INVALID on a secret-shaped or unknown key (strict schema)', () => {
    writeFileSync(cfgPath, JSON.stringify({ version: 1, clientSecret: 'oops' }));
    const { stderr } = spyExit();
    expect(() => loadConfigFile(cfgPath)).toThrow('exit-called');
    expect(String(stderr.mock.calls[0]?.[0])).toContain('E_CONFIG_INVALID');
  });

  it('E_CONFIG_INVALID on a path-traversal alias key', () => {
    writeFileSync(cfgPath, JSON.stringify({ version: 1, accounts: { '../evil': { email: 'e@x.com' } } }));
    const { stderr } = spyExit();
    expect(() => loadConfigFile(cfgPath)).toThrow('exit-called');
    expect(String(stderr.mock.calls[0]?.[0])).toContain('E_CONFIG_INVALID');
  });

  it('E_CONFIG_VERSION_UNSUPPORTED on a newer schema version', () => {
    writeFileSync(cfgPath, JSON.stringify({ version: 2, accounts: {} }));
    const { stderr } = spyExit();
    expect(() => loadConfigFile(cfgPath)).toThrow('exit-called');
    expect(String(stderr.mock.calls[0]?.[0])).toContain('E_CONFIG_VERSION_UNSUPPORTED');
  });
});

describe('mutateConfigFile', () => {
  it('applies the mutation to the latest on-disk state, atomically', () => {
    writeFileSync(cfgPath, JSON.stringify({ version: 1, accounts: { a: { email: 'a@x.com' } } }));
    mutateConfigFile((c) => {
      c.accounts = { ...c.accounts, b: { email: 'b@x.com' } };
      return c;
    }, cfgPath);
    const after = loadConfigFile(cfgPath);
    expect(Object.keys(after?.accounts ?? {})).toEqual(['a', 'b']);
    if (process.platform !== 'win32') expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
  });
});

describe('fs-atomic', () => {
  it('atomicWriteWithLock writes content with 0600 and leaves no droppings', () => {
    const p = path.join(base, 'x.json');
    atomicWriteWithLock(p, 'hello');
    expect(readFileSync(p, 'utf8')).toBe('hello');
    if (process.platform !== 'win32') expect(statSync(p).mode & 0o777).toBe(0o600);
    const leftovers = [
      ...['.x.json.lock'],
    ].filter((f) => existsSync(path.join(base, f)));
    expect(leftovers).toEqual([]);
  });

  it('recovers a corrupt (non-PID) lock file instead of timing out', () => {
    const p = path.join(base, 'y.json');
    writeFileSync(path.join(base, '.y.json.lock'), 'garbage');
    let ran = false;
    withFileLock(p, () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

describe('reload safety (dispatch path must never exit)', () => {
  it("onInvalid 'throw' raises ConfigFileError instead of exiting on a corrupt file", () => {
    writeFileSync(cfgPath, '{mid-edit');
    const exit = vi.spyOn(process, 'exit');
    expect(() => resolveAccounts({} as NodeJS.ProcessEnv, cfgPath, 'throw')).toThrow(ConfigFileError);
    expect(exit).not.toHaveBeenCalled();
  });

  it("onInvalid 'throw' raises on a deleted/empty registry instead of exiting", () => {
    const exit = vi.spyOn(process, 'exit');
    expect(() => resolveAccounts({} as NodeJS.ProcessEnv, cfgPath, 'throw')).toThrow(
      /E_NO_ACCOUNTS_CONFIGURED/,
    );
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('runMigrateConfig', () => {
  it('synthesizes accounts{} with the admin fold and is idempotent', () => {
    const env = {
      GOOGLE_ACCOUNTS: 'work:w@x.com,ops:o@x.com',
      GOOGLE_ADMIN_ACCOUNTS: 'ops',
      XDG_CONFIG_HOME: base,
    } as NodeJS.ProcessEnv;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    runMigrateConfig(env);
    const p = path.join(base, 'mcp-google-multi', 'config.json');
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    expect(cfg.accounts).toEqual({ work: { email: 'w@x.com' }, ops: { email: 'o@x.com', admin: true } });
    expect(env.GOOGLE_ACCOUNTS).toBe('work:w@x.com,ops:o@x.com');
    log.mockClear();
    runMigrateConfig(env);
    expect(log.mock.calls.some((c) => String(c[0]).includes('nothing to do'))).toBe(true);
  });

  it('preserves file-only fields for retained aliases (merge, not replace)', () => {
    const dir = path.join(base, 'mcp-google-multi');
    const p = path.join(dir, 'config.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({ version: 1, accounts: { work: { email: 'w@x.com', scopeProfile: 'custom', admin: true } } }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    runMigrateConfig({ GOOGLE_ACCOUNTS: 'work:w@x.com', XDG_CONFIG_HOME: base } as NodeJS.ProcessEnv);
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    expect(cfg.accounts.work).toEqual({ email: 'w@x.com', scopeProfile: 'custom', admin: true });
    expect(log.mock.calls.some((c) => String(c[0]).includes('nothing to do'))).toBe(true);
  });

  it('does nothing without GOOGLE_ACCOUNTS', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    runMigrateConfig({ XDG_CONFIG_HOME: base } as NodeJS.ProcessEnv);
    expect(existsSync(path.join(base, 'mcp-google-multi', 'config.json'))).toBe(false);
    expect(log.mock.calls.some((c) => String(c[0]).includes('nothing to migrate'))).toBe(true);
  });
});
