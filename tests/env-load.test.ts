import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadEnvFiles } from '../src/env-load.js';

// Each test gets throwaway dirs for all three tiers so the repo's own .env
// (if any) never leaks in.
let base: string;
let cwd: string;
let pkgRoot: string;
let configDir: string;
const dirs = () => ({ cwd, packageRoot: pkgRoot, configDir });

const KEYS = ['EL_A', 'EL_B', 'EL_C', 'EL_REAL'];
let realEnvBackup: Record<string, string | undefined>;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'env-load-'));
  cwd = path.join(base, 'cwd');
  pkgRoot = path.join(base, 'pkg');
  configDir = path.join(base, 'config');
  for (const d of [cwd, pkgRoot, configDir]) mkdirSync(d, { recursive: true });
  realEnvBackup = {};
  for (const k of [...KEYS, 'MCP_GOOGLE_MULTI_ENV']) {
    realEnvBackup[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(realEnvBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(base, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('loadEnvFiles', () => {
  it('T1: no .env on any tier loads nothing and does not throw', () => {
    const res = loadEnvFiles(dirs());
    expect(res.loaded).toEqual([]);
    expect(res.searched).toHaveLength(3);
  });

  it('T2: .env only in the config dir reaches process.env', () => {
    writeFileSync(path.join(configDir, '.env'), 'EL_A=from-config\n');
    const res = loadEnvFiles(dirs());
    expect(process.env.EL_A).toBe('from-config');
    expect(res.loaded).toEqual([path.join(configDir, '.env')]);
  });

  it('T3: MCP_GOOGLE_MULTI_ENV replaces the file search entirely', () => {
    writeFileSync(path.join(configDir, '.env'), 'EL_A=from-config\nEL_B=config-only\n');
    const pointed = path.join(base, 'pointed.env');
    writeFileSync(pointed, 'EL_A=from-pointed\n');
    process.env.MCP_GOOGLE_MULTI_ENV = pointed;
    const res = loadEnvFiles(dirs());
    expect(process.env.EL_A).toBe('from-pointed');
    expect(process.env.EL_B).toBeUndefined();
    expect(res.searched).toEqual([pointed]);
  });

  it('T3b: a missing MCP_GOOGLE_MULTI_ENV path is fatal with E_ENV_NOT_FOUND', () => {
    process.env.MCP_GOOGLE_MULTI_ENV = path.join(base, 'nope.env');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => { throw new Error('exit-called'); });
    expect(() => loadEnvFiles(dirs())).toThrow('exit-called');
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('E_ENV_NOT_FOUND');
    expect(String(stderr.mock.calls[0]?.[0])).toContain('nope.env');
  });

  it('T4: precedence is real env > CWD > package-root > config dir', () => {
    process.env.EL_REAL = 'boot';
    writeFileSync(
      path.join(configDir, '.env'),
      'EL_REAL=config\nEL_A=config\nEL_B=config\nEL_C=config\n',
    );
    writeFileSync(path.join(pkgRoot, '.env'), 'EL_A=pkg\nEL_B=pkg\n');
    writeFileSync(path.join(cwd, '.env'), 'EL_A=cwd\n');
    loadEnvFiles(dirs());
    expect(process.env.EL_REAL).toBe('boot');
    expect(process.env.EL_A).toBe('cwd');
    expect(process.env.EL_B).toBe('pkg');
    expect(process.env.EL_C).toBe('config');
  });

  it('T6: pre-22 Node (no process.loadEnvFile) fails fast with E_NODE_TOO_OLD, no TypeError', () => {
    const original = process.loadEnvFile;
    // @ts-expect-error simulating a pre-22 runtime
    process.loadEnvFile = undefined;
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => { throw new Error('exit-called'); });
    try {
      expect(() => loadEnvFiles(dirs())).toThrow('exit-called');
      expect(exit).toHaveBeenCalledWith(1);
      expect(String(stderr.mock.calls[0]?.[0])).toContain('E_NODE_TOO_OLD');
    } finally {
      process.loadEnvFile = original;
    }
  });

  it('rethrows non-ENOENT loader errors instead of swallowing them', () => {
    // A directory named .env fails at the READ stage (ERR_INVALID_ARG_TYPE on
    // both Linux and Windows) — open()-stage failures all collapse into ENOENT.
    mkdirSync(path.join(cwd, '.env'));
    expect(() => loadEnvFiles(dirs())).toThrow();
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'an unreadable .env in a search tier is skipped, not fatal',
    () => {
      const p = path.join(cwd, '.env');
      writeFileSync(p, 'EL_A=locked\n', { mode: 0o000 });
      const res = loadEnvFiles(dirs());
      expect(res.loaded).toEqual([]);
      expect(process.env.EL_A).toBeUndefined();
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'an unreadable MCP_GOOGLE_MULTI_ENV path is fatal and says so accurately',
    () => {
      const p = path.join(base, 'locked.env');
      writeFileSync(p, 'EL_A=locked\n', { mode: 0o000 });
      process.env.MCP_GOOGLE_MULTI_ENV = p;
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const exit = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => { throw new Error('exit-called'); });
      expect(() => loadEnvFiles(dirs())).toThrow('exit-called');
      expect(exit).toHaveBeenCalledWith(1);
      expect(String(stderr.mock.calls[0]?.[0])).toContain('is not readable');
    },
  );
});
