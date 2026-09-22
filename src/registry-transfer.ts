// B19: encrypted registry export / import (account-registry.md). Moves a whole
// setup to another machine. The bundle is encrypted under a user PASSPHRASE
// (portable across machines with different MASTER_KEYs) via the token-store AES
// primitives; the bundled <alias>.enc token files stay encrypted under the
// SOURCE MASTER_KEY (double-locked), so the target needs the same MASTER_KEY to
// use them. Secrets (MASTER_KEY / client secret) are never in the bundle.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as readline from 'node:readline';
import path from 'node:path';
import { encryptToken, decryptToken } from './token-store.js';
import { atomicWriteFileSync, atomicWriteWithLock } from './fs-atomic.js';
import { configFilePath, CONFIG_VERSION } from './config-file.js';
import { getTokenDir } from './accounts.js';

const ALIAS_RE = /^[a-zA-Z0-9_-]+$/;

export interface TransferBundle {
  manifest: { v: 1; exportedAt: string; aliases: string[] };
  /** Raw config.json contents (plaintext registry; no secrets). */
  config: string | null;
  /** alias -> raw <alias>.enc contents (still under the SOURCE MASTER_KEY). */
  tokens: Record<string, string>;
}

export interface TransferDeps {
  configPath?: string;
  tokenDir?: string;
  fileExists?: (p: string) => boolean;
  readFile?: (p: string) => string;
  listDir?: (p: string) => string[];
}

interface ResolvedDeps {
  configPath: string;
  tokenDir: string;
  fileExists: (p: string) => boolean;
  readFile: (p: string) => string;
  listDir: (p: string) => string[];
}

function resolveDeps(deps: TransferDeps): ResolvedDeps {
  return {
    configPath: deps.configPath ?? configFilePath(),
    tokenDir: deps.tokenDir ?? getTokenDir(),
    fileExists: deps.fileExists ?? existsSync,
    readFile: deps.readFile ?? ((p) => readFileSync(p, 'utf-8')),
    listDir: deps.listDir ?? ((p) => (existsSync(p) ? readdirSync(p) : [])),
  };
}

/** Collect the config + every `<alias>.enc` token file present in the token dir. */
export function buildTransferBundle(exportedAt: string, deps: TransferDeps = {}): TransferBundle {
  const r = resolveDeps(deps);
  const config = r.fileExists(r.configPath) ? r.readFile(r.configPath) : null;
  const tokens: Record<string, string> = {};
  for (const name of r.listDir(r.tokenDir)) {
    if (!name.endsWith('.enc')) continue;
    const alias = name.slice(0, -'.enc'.length);
    if (!ALIAS_RE.test(alias)) continue; // never trust a stray filename as an alias
    tokens[alias] = r.readFile(path.join(r.tokenDir, name));
  }
  // Alias list = token-authed aliases plus any account defined only in config.
  const aliasSet = new Set(Object.keys(tokens));
  if (config) {
    try {
      const accounts = (JSON.parse(config) as { accounts?: Record<string, unknown> }).accounts ?? {};
      for (const a of Object.keys(accounts)) aliasSet.add(a);
    } catch {
      // malformed config is passed through as-is; import will re-validate it.
    }
  }
  return { manifest: { v: 1, exportedAt, aliases: [...aliasSet].sort() }, config, tokens };
}

export function encryptBundle(bundle: TransferBundle, passphrase: string): string {
  return encryptToken(bundle, passphrase);
}

export class BundleDecryptError extends Error {}

export function decryptBundle(contents: string, passphrase: string): TransferBundle {
  let obj: unknown;
  try {
    obj = decryptToken(contents, passphrase) as unknown;
  } catch {
    throw new BundleDecryptError('Could not decrypt the bundle — wrong passphrase or the file is corrupt.');
  }
  const b = obj as Partial<TransferBundle>;
  if (!b || typeof b !== 'object' || !b.manifest || b.manifest.v !== 1 || typeof b.tokens !== 'object') {
    throw new BundleDecryptError('Bundle decrypted but is not a valid registry export (bad manifest).');
  }
  return b as TransferBundle;
}

export interface ImportPlan {
  mergedConfig: string;
  tokenWrites: Record<string, string>;
  added: string[];
  replaced: string[];
  skipped: string[];
}

interface ConfigShape {
  version: number;
  accounts: Record<string, unknown>;
  scopeProfiles?: Record<string, unknown>;
  [k: string]: unknown;
}

function parseConfig(raw: string | null): ConfigShape {
  if (!raw || raw.trim() === '') return { version: CONFIG_VERSION, accounts: {} };
  const parsed = JSON.parse(raw) as ConfigShape;
  if (typeof parsed !== 'object' || parsed === null) throw new Error('config is not an object');
  parsed.accounts ??= {};
  parsed.version ??= CONFIG_VERSION;
  return parsed;
}

/**
 * Merge the bundle into the local registry. Default MERGE = add non-colliding
 * aliases; a collision is skipped (never clobbers a local account's tokens)
 * unless `replace` is set. Pure for unit testing.
 */
export function planImport(
  bundle: TransferBundle,
  localConfigRaw: string | null,
  opts: { replace?: boolean } = {},
): ImportPlan {
  const local = parseConfig(localConfigRaw);
  const incoming = parseConfig(bundle.config);
  const replace = opts.replace === true;

  const added: string[] = [];
  const replaced: string[] = [];
  const skipped: string[] = [];
  const nextAccounts: Record<string, unknown> = { ...local.accounts };
  const nextProfiles: Record<string, unknown> = { ...(local.scopeProfiles ?? {}) };
  const tokenWrites: Record<string, string> = {};

  const incomingAccounts = incoming.accounts ?? {};
  const incomingProfiles = incoming.scopeProfiles ?? {};

  for (const alias of Object.keys(incomingAccounts)) {
    const collides = Object.prototype.hasOwnProperty.call(local.accounts, alias);
    if (collides && !replace) {
      skipped.push(alias);
      continue;
    }
    nextAccounts[alias] = incomingAccounts[alias];
    // carry the account's scope profile if it points at one
    const row = incomingAccounts[alias] as { scopeProfile?: string };
    if (row?.scopeProfile && Object.prototype.hasOwnProperty.call(incomingProfiles, row.scopeProfile)) {
      nextProfiles[row.scopeProfile] = incomingProfiles[row.scopeProfile];
    }
    if (bundle.tokens[alias]) tokenWrites[alias] = bundle.tokens[alias];
    (collides ? replaced : added).push(alias);
  }

  // Token files with no config account (authed but registry-less) follow the
  // same collision rule keyed on whether we already wrote/kept that alias.
  for (const alias of Object.keys(bundle.tokens)) {
    if (alias in tokenWrites || added.includes(alias) || replaced.includes(alias)) continue;
    if (Object.prototype.hasOwnProperty.call(local.accounts, alias) && !replace) continue;
    tokenWrites[alias] = bundle.tokens[alias];
  }

  const merged: ConfigShape = { ...local, version: local.version ?? CONFIG_VERSION, accounts: nextAccounts };
  if (Object.keys(nextProfiles).length > 0) merged.scopeProfiles = nextProfiles;
  return {
    mergedConfig: `${JSON.stringify(merged, null, 2)}\n`,
    tokenWrites,
    added: added.sort(),
    replaced: replaced.sort(),
    skipped: skipped.sort(),
  };
}

// ---- CLI -------------------------------------------------------------------

function argFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Passphrase from MCP_TRANSFER_PASSPHRASE (automation) or a TTY prompt; never
 * a CLI flag (would leak in the process list). */
async function resolvePassphrase(prompt: string): Promise<string | null> {
  const fromEnv = process.env.MCP_TRANSFER_PASSPHRASE;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (!process.stdin.isTTY) return null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer: string = await new Promise((resolve) => rl.question(prompt, resolve));
    return answer.trim() || null;
  } finally {
    rl.close();
  }
}

export async function runExportCli(argv: string[]): Promise<number> {
  const out = argFlag(argv, '--out');
  if (!out) {
    console.error('Usage: mcp-google-multi account export --out <bundle.enc>');
    return 2;
  }
  const passphrase = await resolvePassphrase('Choose a passphrase to encrypt the export: ');
  if (!passphrase) {
    console.error('E_INPUT_REQUIRED: a passphrase is required. Set MCP_TRANSFER_PASSPHRASE or run in a terminal.');
    return 2;
  }
  const bundle = buildTransferBundle(new Date().toISOString());
  atomicWriteFileSync(path.resolve(out), encryptBundle(bundle, passphrase), 0o600);
  console.error(`Exported ${bundle.manifest.aliases.length} account(s) to ${out} (0600).`);
  console.error(
    'Note: the bundled token files stay encrypted under this machine\'s MASTER_KEY. To use the tokens on the target, set the same MASTER_KEY there; otherwise re-authenticate with account_reauth.',
  );
  return 0;
}

export async function runImportCli(argv: string[]): Promise<number> {
  const file = argv[argv.indexOf('import') + 1];
  if (!file || file.startsWith('--')) {
    console.error('Usage: mcp-google-multi account import <bundle.enc> [--replace]');
    return 2;
  }
  const replace = argv.includes('--replace');
  if (!existsSync(path.resolve(file))) {
    console.error(`E_NOT_FOUND: ${file}`);
    return 2;
  }
  const passphrase = await resolvePassphrase('Passphrase to decrypt the bundle: ');
  if (!passphrase) {
    console.error('E_INPUT_REQUIRED: a passphrase is required. Set MCP_TRANSFER_PASSPHRASE or run in a terminal.');
    return 2;
  }
  let bundle: TransferBundle;
  try {
    bundle = decryptBundle(readFileSync(path.resolve(file), 'utf-8'), passphrase);
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }

  const cfgPath = configFilePath();
  const localRaw = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf-8') : null;
  let plan: ImportPlan;
  try {
    plan = planImport(bundle, localRaw, { replace });
  } catch (e) {
    console.error(`E_CONFIG_INVALID: the bundle's config could not be merged: ${(e as Error).message}`);
    return 1;
  }

  atomicWriteWithLock(cfgPath, plan.mergedConfig, 0o600);
  const tokenDir = getTokenDir();
  for (const [alias, contents] of Object.entries(plan.tokenWrites)) {
    atomicWriteFileSync(path.join(tokenDir, `${alias}.enc`), contents, 0o600);
  }
  if (process.env.GOOGLE_ACCOUNTS?.trim()) {
    console.error(
      'Note: GOOGLE_ACCOUNTS is set, so config.json is ignored (env-sourced mode). The imported registry takes effect once you unset GOOGLE_ACCOUNTS. Token files were still placed.',
    );
  }
  console.error(
    `Imported: ${plan.added.length} added${plan.added.length ? ` (${plan.added.join(', ')})` : ''}, ` +
      `${plan.replaced.length} replaced${plan.replaced.length ? ` (${plan.replaced.join(', ')})` : ''}, ` +
      `${plan.skipped.length} skipped${plan.skipped.length ? ` (${plan.skipped.join(', ')}; re-run with --replace to overwrite)` : ''}.`,
  );
  console.error('Run `mcp-google-multi doctor` to verify token health (tokens need the source MASTER_KEY; otherwise account_reauth).');
  return 0;
}
