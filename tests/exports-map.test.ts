import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The exports map is the public API surface: every declared subpath must map
// onto a real source module, and compose must stay import-side-effect-free.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  exports: Record<string, string>;
  files: string[];
  main: string;
};

describe('package exports map', () => {
  it('every declared subpath maps ./dist/<name>.js onto an existing src/<name>.ts', () => {
    for (const [key, target] of Object.entries(pkg.exports)) {
      if (key === './package.json') {
        expect(target).toBe('./package.json');
        continue;
      }
      expect(target).toMatch(/^\.\/dist\/[a-z-]+\.js$/);
      const srcName = target.replace('./dist/', '').replace(/\.js$/, '.ts');
      expect(existsSync(path.join(repoRoot, 'src', srcName)), `src/${srcName} for exports["${key}"]`).toBe(true);
    }
  });

  it('the root export and main agree, and the published dirs are dist and skills', () => {
    expect(pkg.exports['.']).toBe(`./${pkg.main}`);
    expect(pkg.files).toEqual(['dist', 'skills']);
  });

  it('./write-control is declared: a caller building its own context can resolve a Policy', async () => {
    expect(pkg.exports['./write-control']).toBe('./dist/write-control.js');
    const m = await import('../src/write-control.js');
    expect(typeof m.resolvePolicy).toBe('function');
    expect(typeof m.isAllowed).toBe('function');
  });

  it('./scope-catalog and ./auth are declared: a tenant link can compute the same scopes core resolves', async () => {
    expect(pkg.exports['./scope-catalog']).toBe('./dist/scope-catalog.js');
    expect(pkg.exports['./auth']).toBe('./dist/auth.js');
    const catalog = await import('../src/scope-catalog.js');
    expect(typeof catalog.resolveBundleAliases).toBe('function');
    expect(typeof catalog.closestBundle).toBe('function');
    expect(typeof catalog.BUNDLE_CATALOG).toBe('object');
    const auth = await import('../src/auth.js');
    expect(Array.isArray(auth.BASE_SCOPES)).toBe(true);
    expect(typeof auth.resolveScopesForAccount).toBe('function');
  });

  it('./http-confirm and ./scope-observability are declared: a host that builds its own servers can confirm writes and read per-account scope sets', async () => {
    expect(pkg.exports['./http-confirm']).toBe('./dist/http-confirm.js');
    expect(pkg.exports['./scope-observability']).toBe('./dist/scope-observability.js');
    const confirm = await import('../src/http-confirm.js');
    expect(typeof confirm.HttpConfirm).toBe('function');
    expect(typeof confirm.confirmTokenEnabled).toBe('function');
    const scopes = await import('../src/scope-observability.js');
    expect(typeof scopes.accountScopeSets).toBe('function');
    expect(typeof scopes.summarizeToolScopes).toBe('function');
    expect(typeof scopes.classifyMethodScopes).toBe('function');
  });

  // The map points at dist, so only the built package proves a subpath
  // resolves for a consumer. Every build-then-test job in CI exercises this;
  // a local run without a build skips it.
  const built = existsSync(path.join(repoRoot, 'dist', 'index.js'));
  it.skipIf(!built && !process.env.CI)(
    'every declared subpath imports from the built package by its public name',
    { timeout: 60_000 },
    () => {
      const subs = Object.keys(pkg.exports).filter((k) => k !== '.' && k !== './package.json');
      const script = `
        const subs = ${JSON.stringify(subs)};
        for (const s of subs) {
          const m = await import('mcp-google-multi/' + s.slice(2));
          if (!m || Object.keys(m).length === 0) { console.error('EMPTY ' + s); process.exit(1); }
        }
        console.log('ALL_OK ' + subs.length);
      `;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 45_000,
      });
      expect(`${r.stdout}${r.stderr}`).toContain(`ALL_OK ${subs.length}`);
      expect(r.status).toBe(0);
    },
  );

  it('the 6 public entry points are all declared', () => {
    for (const key of ['./identity', './compose', './oauth-as', './accounts', './token-store', './http-transport']) {
      expect(pkg.exports[key], key).toBeTruthy();
    }
  });
});

describe('compose is import-side-effect-free', () => {
  it('importing src/compose.ts never parses argv, starts a server, or exits non-zero', { timeout: 60_000 }, () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mcp-gm-compose-'));
    const emptyEnv = path.join(home, 'empty.env');
    writeFileSync(emptyEnv, '');
    const env = { ...process.env } as NodeJS.ProcessEnv;
    Object.assign(env, {
      XDG_CONFIG_HOME: home,
      TOKEN_STORE_PATH: path.join(home, 'tokens'),
      MCP_GOOGLE_MULTI_ENV: emptyEnv,
      GOOGLE_ACCOUNTS: 'test:test@example.com',
    });
    const r = spawnSync(
      process.execPath,
      // argv carries a subcommand-shaped token: an index-style argv dispatch
      // would react to it; a clean composition module must not.
      ['--import', 'tsx', '-e', "import('./src/compose.ts').then((m) => { console.log('IMPORT_OK', typeof m.buildRegistry); })", 'doctor'],
      { cwd: repoRoot, env, encoding: 'utf8', timeout: 45_000 },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('IMPORT_OK function');
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/listening|Usage:|E_OWNER_EMAILS_REQUIRED/);
  });
});
