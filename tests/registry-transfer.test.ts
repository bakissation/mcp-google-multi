import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  buildTransferBundle,
  encryptBundle,
  decryptBundle,
  BundleDecryptError,
  planImport,
  refuseIfMultiTenant,
  runExportCli,
  type TransferBundle,
  type TransferDeps,
} from '../src/registry-transfer.js';

// Token paths are built with the module's native path.join, so the fake store
// keys them the same way (keeps the test correct on Windows runners too).
function fakeDeps(opts: {
  config?: string | null;
  tokens?: Record<string, string>;
  strayNames?: string[];
  tokenDir?: string;
  configPath?: string;
}): TransferDeps {
  const tokenDir = opts.tokenDir ?? path.join('/cfg', 'tokens');
  const configPath = opts.configPath ?? path.join('/cfg', 'config.json');
  const store = new Map<string, string>();
  if (opts.config != null) store.set(configPath, opts.config);
  const names: string[] = [];
  for (const [alias, contents] of Object.entries(opts.tokens ?? {})) {
    names.push(`${alias}.enc`);
    store.set(path.join(tokenDir, `${alias}.enc`), contents);
  }
  names.push(...(opts.strayNames ?? []));
  return {
    configPath,
    tokenDir,
    fileExists: (p) => store.has(p),
    readFile: (p) => {
      const v = store.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    listDir: () => names,
  };
}

const CONFIG = JSON.stringify({
  version: 1,
  accounts: { work: { email: 'w@x.example', scopeProfile: 'work' }, personal: { email: 'p@x.example' } },
  scopeProfiles: { work: { bundles: ['forms'] } },
});

describe('buildTransferBundle', () => {
  it('collects config + every <alias>.enc token file, aliases sorted', () => {
    const b = buildTransferBundle(
      '2026-01-01T00:00:00Z',
      fakeDeps({ config: CONFIG, tokens: { work: 'ENC-work', personal: 'ENC-personal' }, strayNames: ['notes.txt'] }),
    );
    expect(b.manifest).toEqual({ v: 1, exportedAt: '2026-01-01T00:00:00Z', aliases: ['personal', 'work'] });
    expect(b.tokens).toEqual({ 'work': 'ENC-work', 'personal': 'ENC-personal' });
    expect(b.config).toBe(CONFIG);
  });

  it('includes a config-only account that has no token file', () => {
    const b = buildTransferBundle('t', fakeDeps({ config: CONFIG }));
    expect(b.manifest.aliases).toEqual(['personal', 'work']);
    expect(b.tokens).toEqual({});
  });

  it('ignores stray filenames that are not valid aliases', () => {
    const b = buildTransferBundle('t', fakeDeps({ config: null, tokens: { ok: 'y' }, strayNames: ['../evil.enc'] }));
    expect(Object.keys(b.tokens)).toEqual(['ok']);
  });
});

describe('encrypt/decrypt bundle (passphrase)', () => {
  const bundle: TransferBundle = {
    manifest: { v: 1, exportedAt: 't', aliases: ['work'] },
    config: CONFIG,
    tokens: { work: 'ENC-work' },
  };

  it('round-trips under the correct passphrase', () => {
    const blob = encryptBundle(bundle, 'correct horse battery staple');
    const back = decryptBundle(blob, 'correct horse battery staple');
    expect(back).toEqual(bundle);
  });

  it('the ciphertext contains no plaintext account data', () => {
    const blob = encryptBundle(bundle, 'pw');
    expect(blob).not.toContain('w@x.example');
    expect(blob).not.toContain('ENC-work');
  });

  it('a wrong passphrase throws BundleDecryptError, not a raw crypto error', () => {
    const blob = encryptBundle(bundle, 'right');
    expect(() => decryptBundle(blob, 'wrong')).toThrow(BundleDecryptError);
  });

  it('envelope is scrypt v2: per-bundle salt, no two exports alike (S-sec)', () => {
    const a = JSON.parse(encryptBundle(bundle, 'pw')) as { bv: number; salt: string };
    const b = JSON.parse(encryptBundle(bundle, 'pw')) as { bv: number; salt: string };
    expect(a.bv).toBe(2);
    expect(a.salt).toBeTruthy();
    expect(a.salt).not.toBe(b.salt);
  });

  it('refuses the retired v1 (prerelease) envelope with a re-export hint', () => {
    const v1 = JSON.stringify({ v: 1, iv: 'aa', tag: 'bb', data: 'cc' });
    expect(() => decryptBundle(v1, 'pw')).toThrow(/retired v1 prerelease format/);
  });

  it('rejects a decrypted blob that is not a valid bundle', () => {
    // encrypt an arbitrary object with the passphrase, then try to import it
    const blob = encryptBundle({ nope: true } as unknown as TransferBundle, 'pw');
    expect(() => decryptBundle(blob, 'pw')).toThrow(BundleDecryptError);
  });
});

describe('refuseIfMultiTenant (S1.19, invariant 9)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'gm-mt-'));
    dirs.push(d);
    return d;
  };

  it('fires on a tenant-namespaced store and names the dir', () => {
    const base = tmp();
    const tenants = path.join(base, 'tenants');
    mkdirSync(path.join(tenants, 'tenant-a', 'tokens'), { recursive: true });
    expect(refuseIfMultiTenant(tenants)).toBe(tenants);
  });

  it('no-ops on a flat store: absent or EMPTY tenants dir', () => {
    const base = tmp();
    expect(refuseIfMultiTenant(path.join(base, 'tenants'))).toBeNull();
    mkdirSync(path.join(base, 'tenants'));
    expect(refuseIfMultiTenant(path.join(base, 'tenants'))).toBeNull();
  });

  it('the export CLI refuses with E_MULTI_TENANT_EXPORT_REFUSED before touching anything', async () => {
    // the sandboxed XDG configDir is where the default predicate looks
    const tenants = path.join(process.env.XDG_CONFIG_HOME!, 'mcp-google-multi', 'tenants');
    mkdirSync(path.join(tenants, 'tenant-a'), { recursive: true });
    const errs: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((m: string) => void errs.push(String(m)));
    try {
      const code = await runExportCli(['account', 'export', '--out', path.join(tmp(), 'b.enc')]);
      expect(code).toBe(2);
      expect(errs.join(' ')).toContain('E_MULTI_TENANT_EXPORT_REFUSED');
    } finally {
      errSpy.mockRestore();
      rmSync(tenants, { recursive: true, force: true });
    }
  });
});

describe('planImport', () => {
  const bundle: TransferBundle = {
    manifest: { v: 1, exportedAt: 't', aliases: ['work', 'personal'] },
    config: CONFIG,
    tokens: { work: 'ENC-work', personal: 'ENC-personal' },
  };

  it('merges into an empty local registry (all added)', () => {
    const plan = planImport(bundle, null);
    expect(plan.added).toEqual(['personal', 'work']);
    expect(plan.replaced).toEqual([]);
    expect(plan.skipped).toEqual([]);
    const merged = JSON.parse(plan.mergedConfig);
    expect(Object.keys(merged.accounts)).toEqual(['work', 'personal']);
    expect(merged.scopeProfiles.work).toEqual({ bundles: ['forms'] });
    expect(plan.tokenWrites).toEqual({ work: 'ENC-work', personal: 'ENC-personal' });
  });

  it('skips a colliding alias by default (never clobbers local tokens)', () => {
    const local = JSON.stringify({ version: 1, accounts: { work: { email: 'local@x.example' } } });
    const plan = planImport(bundle, local);
    expect(plan.skipped).toEqual(['work']);
    expect(plan.added).toEqual(['personal']);
    // local work account + tokens untouched
    expect(JSON.parse(plan.mergedConfig).accounts.work.email).toBe('local@x.example');
    expect(plan.tokenWrites).toEqual({ personal: 'ENC-personal' });
  });

  it('--replace overwrites the colliding alias and its tokens', () => {
    const local = JSON.stringify({ version: 1, accounts: { work: { email: 'local@x.example' } } });
    const plan = planImport(bundle, local, { replace: true });
    expect(plan.replaced).toEqual(['work']);
    expect(plan.skipped).toEqual([]);
    expect(JSON.parse(plan.mergedConfig).accounts.work.email).toBe('w@x.example');
    expect(plan.tokenWrites.work).toBe('ENC-work');
  });

  it('imports a token-only alias absent from any config account', () => {
    const tokenOnly: TransferBundle = { manifest: { v: 1, exportedAt: 't', aliases: ['x'] }, config: null, tokens: { x: 'ENC-x' } };
    const plan = planImport(tokenOnly, null);
    expect(plan.tokenWrites).toEqual({ x: 'ENC-x' });
  });

  it('preserves unrelated local accounts and top-level keys', () => {
    const local = JSON.stringify({ version: 1, accounts: { other: { email: 'o@x.example' } }, discovery: 'curated' });
    const plan = planImport(bundle, local);
    const merged = JSON.parse(plan.mergedConfig);
    expect(merged.accounts.other).toEqual({ email: 'o@x.example' });
    expect(merged.discovery).toBe('curated');
    expect(Object.keys(merged.accounts).sort()).toEqual(['other', 'personal', 'work']);
  });
});
