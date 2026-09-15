import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAccounts, accountAliasSchemaFor } from '../src/accounts.js';

// Gap #23: a fresh install (zero accounts) must NOT crash the bootstrap/diagnostic
// CLIs at module load. resolveAccounts and the account-field schema are the two
// module-load choke points; both are exercised here without a subprocess.

const nonexistent = () => path.join(mkdtempSync(path.join(tmpdir(), 'mcp-gm-empty-')), 'config.json');

describe('resolveAccounts on an empty registry (gap #23)', () => {
  it('returns an empty AccountSet (not a process exit) at module-load severity', () => {
    // env with NO GOOGLE_ACCOUNTS + an absent config.json => zero accounts.
    const set = resolveAccounts({}, nonexistent(), 'exit');
    expect(set.aliases).toEqual([]);
    expect(set.configs).toEqual({});
    expect(set.source).toBe('file');
    expect(set.defaultAccount).toBeUndefined();
    // the always-present base profile survives so scope resolution stays valid
    expect(set.scopeProfiles.base).toEqual({ bundles: [] });
  });

  it('also tolerates a present-but-accountless config.json', () => {
    const file = nonexistent();
    writeFileSync(file, JSON.stringify({ version: 1, accounts: {} }));
    const set = resolveAccounts({}, file, 'exit');
    expect(set.aliases).toEqual([]);
  });

  it('STILL throws on the reload path so a mid-session empty keeps the last-good set (BR-7)', () => {
    // onInvalid: 'throw' is the dispatch-reload contract — it must not silently
    // drop a running server to zero accounts.
    expect(() => resolveAccounts({}, nonexistent(), 'throw')).toThrowError(/E_NO_ACCOUNTS_CONFIGURED/);
  });

  it('resolves normally when accounts are present (no regression)', () => {
    const set = resolveAccounts({ GOOGLE_ACCOUNTS: 'work:w@example.com,personal:p@example.com' }, nonexistent(), 'exit');
    expect(set.aliases).toEqual(['work', 'personal']);
    expect(set.configs.work.email).toBe('w@example.com');
  });
});

describe('accountAliasSchemaFor: empty-safe account field (gap #23)', () => {
  it('falls back to a plain string when there are no aliases (z.enum would throw)', () => {
    const schema = accountAliasSchemaFor([]);
    // any string parses — there is nothing to enumerate, and dispatch validates
    // against the live set anyway
    expect(schema.safeParse('anything').success).toBe(true);
    expect(schema.safeParse('work').success).toBe(true);
  });

  it('is a strict enum when aliases exist (rejects unknown aliases)', () => {
    const schema = accountAliasSchemaFor(['work', 'personal']);
    expect(schema.safeParse('work').success).toBe(true);
    expect(schema.safeParse('personal').success).toBe(true);
    expect(schema.safeParse('nope').success).toBe(false);
    expect(schema.safeParse(123 as unknown as string).success).toBe(false);
  });
});

// End-to-end: a real process on a truly empty registry. Guards the two invariants
// that no in-process test can reach (the account snapshot is non-empty in-suite):
// the bootstrap/diagnostic CLIs must RUN, and the SERVER must REFUSE (BR-4).
describe('empty registry, end-to-end via the CLI (gap #23)', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const srcIndex = path.join(repoRoot, 'src', 'index.ts');

  // Run the built entry through tsx (reflects src, no dist dependency) on a fresh
  // config home, with MCP_GOOGLE_MULTI_ENV pointed at an EMPTY file so a stray
  // repo-root .env can't leak accounts in. stdin is closed so the server can't hang.
  function runCli(args: string[]): { status: number | null; out: string } {
    const home = mkdtempSync(path.join(tmpdir(), 'mcp-gm-e2e-'));
    const emptyEnv = path.join(home, 'empty.env');
    writeFileSync(emptyEnv, '');
    const env = { ...process.env } as NodeJS.ProcessEnv;
    for (const k of ['GOOGLE_ACCOUNTS', 'GOOGLE_ADMIN_ACCOUNTS', 'GOOGLE_OPTIONAL_SCOPES', 'GOOGLE_DEFAULT_ACCOUNT']) delete env[k];
    env.XDG_CONFIG_HOME = home;
    env.TOKEN_STORE_PATH = path.join(home, 'tokens');
    env.MCP_GOOGLE_MULTI_ENV = emptyEnv;
    // cwd = repoRoot so `--import tsx` resolves from node_modules; MCP_GOOGLE_MULTI_ENV
    // (an empty file) already bypasses all .env search tiers, so no repo .env leaks.
    const r = spawnSync(process.execPath, ['--import', 'tsx', srcIndex, ...args], {
      cwd: repoRoot,
      env,
      input: '',
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  }

  it('`doctor` RUNS and reports the missing accounts (no module-load crash)', () => {
    const { status, out } = runCli(['doctor']);
    // The full report rendered — proof the process reached main(), not an
    // import-time exit — and the Config section flags the empty registry.
    expect(out).toMatch(/Runtime/);
    expect(out).toMatch(/No accounts configured/i);
    expect(status).toBe(1); // Overall FAIL
  });

  it('`account import` RUNS on an empty registry (bootstraps a fresh machine)', () => {
    const { out } = runCli(['account', 'import', path.join(tmpdir(), 'does-not-exist.enc')]);
    // The import CLI executed and reported the missing bundle, rather than dying
    // at module load with the no-accounts error.
    expect(out).toMatch(/E_NOT_FOUND/);
    expect(out).not.toMatch(/E_NO_ACCOUNTS_CONFIGURED/);
  });

  it('the SERVER still REFUSES to boot on an empty registry (BR-4)', () => {
    const { status, out } = runCli([]); // no subcommand => server path
    expect(status).not.toBe(0);
    expect(out).toMatch(/E_NO_ACCOUNTS_CONFIGURED/);
  });
});
