import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveAccounts, invalidateAccountSet } from '../src/accounts.js';
import { BUNDLE_CATALOG, ADMIN_SCOPES } from '../src/scope-catalog.js';
import { OPTIONAL_SCOPE_BUNDLES, resolveScopesForAccount, getAdminAccounts, getOptionalBundles } from '../src/auth.js';
import { mkdirSync } from 'node:fs';

let base: string;
let cfgPath: string;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'scopes-'));
  cfgPath = path.join(base, 'config.json');
  delete process.env.GOOGLE_OPTIONAL_SCOPES;
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  delete process.env.GOOGLE_OPTIONAL_SCOPES;
  vi.restoreAllMocks();
});

describe('bundle catalog', () => {
  it('carries the 19 v5 bundles plus admin, each with description and risk', () => {
    expect(Object.keys(BUNDLE_CATALOG)).toHaveLength(20);
    expect(BUNDLE_CATALOG.admin.scopes).toEqual(ADMIN_SCOPES);
    expect(BUNDLE_CATALOG.admin.workspaceOnly).toBe(true);
    for (const [name, entry] of Object.entries(BUNDLE_CATALOG)) {
      expect(entry.description.length, name).toBeGreaterThan(10);
      expect(['low', 'medium', 'high']).toContain(entry.risk);
      expect(entry.scopes.length, name).toBeGreaterThan(0);
    }
  });

  it('derived OPTIONAL_SCOPE_BUNDLES keeps the v5 shape without admin', () => {
    expect(Object.keys(OPTIONAL_SCOPE_BUNDLES)).toHaveLength(19);
    expect(OPTIONAL_SCOPE_BUNDLES.admin).toBeUndefined();
    expect(OPTIONAL_SCOPE_BUNDLES.gmail_settings_sharing).toEqual([
      'https://www.googleapis.com/auth/gmail.settings.sharing',
    ]);
  });
});

describe('acceptance: per-account consent from config.json (live set)', () => {
  const savedAccounts = process.env.GOOGLE_ACCOUNTS;

  afterEach(() => {
    process.env.GOOGLE_ACCOUNTS = savedAccounts;
    invalidateAccountSet();
  });

  it('work gets admin + gmail_settings; personal is never asked for them; union registers both services', () => {
    const xdg = process.env.XDG_CONFIG_HOME!;
    const dir = path.join(xdg, 'mcp-google-multi');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({
        version: 1,
        accounts: {
          work: { email: 'w@co.example', scopeProfile: 'workspace-admin' },
          personal: { email: 'p@gmail.example' },
        },
        scopeProfiles: {
          'workspace-admin': { bundles: ['gmail_settings', 'chat'], admin: true },
        },
      }),
    );
    delete process.env.GOOGLE_ACCOUNTS;
    invalidateAccountSet();

    const work = resolveScopesForAccount('work');
    expect(work).toContain('https://www.googleapis.com/auth/gmail.settings.basic');
    expect(work).toEqual(expect.arrayContaining(ADMIN_SCOPES));

    const personal = resolveScopesForAccount('personal');
    expect(personal).not.toContain('https://www.googleapis.com/auth/gmail.settings.basic');
    for (const s of ADMIN_SCOPES) expect(personal).not.toContain(s);
    expect(personal).toContain('https://www.googleapis.com/auth/gmail.modify');

    expect(getAdminAccounts()).toEqual(['work']);
    expect(getOptionalBundles().sort()).toEqual(['chat', 'gmail_settings']);
  });
});

describe('review fixes (boot validation, reserved names, zero scopes)', () => {
  it('a typo in GOOGLE_OPTIONAL_SCOPES fails at RESOLVE time, whatever GOOGLE_TOOLSETS selects', () => {
    writeFileSync(cfgPath, JSON.stringify({ version: 1, accounts: { a: { email: 'a@x.com' } } }));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit-called');
    });
    expect(() =>
      resolveAccounts({ GOOGLE_OPTIONAL_SCOPES: 'form' } as NodeJS.ProcessEnv, cfgPath),
    ).toThrow('exit-called');
    expect(String(stderr.mock.calls[0]?.[0])).toContain('did you mean "forms"');
  });

  it('"admin" in the legacy env gets the real remediation, not a self-referential hint', () => {
    writeFileSync(cfgPath, JSON.stringify({ version: 1, accounts: { a: { email: 'a@x.com' } } }));
    expect(() =>
      resolveAccounts({ GOOGLE_OPTIONAL_SCOPES: 'admin' } as NodeJS.ProcessEnv, cfgPath, 'throw'),
    ).toThrow(/GOOGLE_ADMIN_ACCOUNTS/);
  });

  it('a scope profile named like an Object.prototype member is rejected, not resolved to a function', () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 1,
        accounts: { a: { email: 'a@x.com', scopeProfile: 'constructor' } },
      }),
    );
    expect(() => resolveAccounts({} as NodeJS.ProcessEnv, cfgPath, 'throw')).toThrow(
      /E_CONFIG_INVALID.*"constructor"/,
    );
    writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 1,
        accounts: { a: { email: 'a@x.com' } },
        scopeProfiles: { constructor: { bundles: [] } },
      }),
    );
    expect(() => resolveAccounts({} as NodeJS.ProcessEnv, cfgPath, 'throw')).toThrow(
      /reserved name "constructor"/,
    );
  });

  it('a zero-scope profile (includesBase:false, no bundles, no admin) is invalid at load', () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 1,
        accounts: { a: { email: 'a@x.com', scopeProfile: 'empty' } },
        scopeProfiles: { empty: { bundles: [], includesBase: false } },
      }),
    );
    expect(() => resolveAccounts({} as NodeJS.ProcessEnv, cfgPath, 'throw')).toThrow(
      /zero scopes/,
    );
  });
});

describe('per-account scope profiles (file registry)', () => {
  const writeCfg = () =>
    writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 1,
        accounts: {
          work: { email: 'w@co.example', scopeProfile: 'workspace-admin' },
          personal: { email: 'p@gmail.example' },
        },
        scopeProfiles: {
          'workspace-admin': { bundles: ['gmail_settings', 'chat'], admin: true },
        },
      }),
    );

  it('resolves per-account profiles; missing scopeProfile defaults to base', () => {
    writeCfg();
    const set = resolveAccounts({} as NodeJS.ProcessEnv, cfgPath);
    expect(set.scopeProfiles['workspace-admin'].admin).toBe(true);
    expect(set.scopeProfiles.base).toEqual({ bundles: [] });
    expect(set.configs.work.scopeProfile).toBe('workspace-admin');
    expect(set.configs.personal.scopeProfile).toBeUndefined();
  });

  it('E_UNKNOWN_BUNDLE at load names bundle, profile and closest key', () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 1,
        accounts: { a: { email: 'a@x.com' } },
        scopeProfiles: { p1: { bundles: ['gmail_setings'] } },
      }),
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit-called');
    });
    expect(() => resolveAccounts({} as NodeJS.ProcessEnv, cfgPath)).toThrow('exit-called');
    expect(exit).toHaveBeenCalledWith(1);
    const msg = String(stderr.mock.calls[0]?.[0]);
    expect(msg).toContain('E_UNKNOWN_BUNDLE');
    expect(msg).toContain('"gmail_setings"');
    expect(msg).toContain('"p1"');
    expect(msg).toContain('did you mean "gmail_settings"');
  });

  it("throw mode raises instead of exiting (reload path)", () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 1,
        accounts: { a: { email: 'a@x.com' } },
        scopeProfiles: { p1: { bundles: ['nope'] } },
      }),
    );
    const exit = vi.spyOn(process, 'exit');
    expect(() => resolveAccounts({} as NodeJS.ProcessEnv, cfgPath, 'throw')).toThrow(/E_UNKNOWN_BUNDLE/);
    expect(exit).not.toHaveBeenCalled();
  });

  it('an account referencing an undefined profile fails E_CONFIG_INVALID', () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 1,
        accounts: { a: { email: 'a@x.com', scopeProfile: 'ghost' } },
      }),
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit-called');
    });
    expect(() => resolveAccounts({} as NodeJS.ProcessEnv, cfgPath)).toThrow('exit-called');
    const msg = String(stderr.mock.calls[0]?.[0]);
    expect(msg).toContain('E_CONFIG_INVALID');
    expect(msg).toContain('"ghost"');
  });
});
