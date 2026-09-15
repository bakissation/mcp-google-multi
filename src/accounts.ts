import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import { loadEnvFiles } from './env-load.js';
import { CONFIG_VERSION, configDir, configFilePath, failStartup, loadConfigFile, mutateConfigFile } from './config-file.js';
import type { ConfigFile } from './config-file.js';
import { BUNDLE_CATALOG, closestBundle, resolveBundleAliases } from './scope-catalog.js';
import type { ScopeProfile } from './scope-catalog.js';

const envLoad = loadEnvFiles();

const defaultTokenDir = path.join(configDir(), 'tokens');
const tokenDir = process.env.TOKEN_STORE_PATH
  ? path.resolve(process.env.TOKEN_STORE_PATH)
  : defaultTokenDir;

export function getTokenDir(): string {
  return tokenDir;
}

export interface AccountConfig {
  email: string;
  tokenPath: string;
  encPath: string;
  scopeProfile?: string;
  admin?: boolean;
  source: 'config' | 'env';
}

export interface AccountSet {
  // May be empty: a fresh install has zero accounts, and the bootstrap /
  // diagnostic CLIs (doctor, reset, account import, migrate-config, config
  // check) must run on it. The SERVER refuses to boot empty — see
  // assertServerAccountsConfigured (BR-4).
  aliases: string[];
  configs: Record<string, AccountConfig>;
  scopeProfiles: Record<string, ScopeProfile>;
  source: 'env' | 'file' | 'merged';
  stamp: string;
  defaultAccount?: string;
  defaultAccountSource?: 'env' | 'config';
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

function accountPaths(alias: string): { tokenPath: string; encPath: string } {
  return {
    tokenPath: path.join(tokenDir, alias, 'token.json'),
    encPath: path.join(tokenDir, `${alias}.enc`),
  };
}

/** v5 env parser, guards verbatim. Format: GOOGLE_ACCOUNTS="alias1:email1,alias2:email2". */
function parseEnvAccounts(raw: string, adminAliases: string[]): { aliases: string[]; configs: Record<string, AccountConfig> } {
  const configs: Record<string, AccountConfig> = {};
  const aliases: string[] = [];

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) {
      throw new Error(
        `Invalid account entry "${trimmed}". Expected format: alias:email`,
      );
    }

    const alias = trimmed.slice(0, colonIdx).trim();
    const email = trimmed.slice(colonIdx + 1).trim();

    if (!alias || !email) {
      throw new Error(
        `Invalid account entry "${trimmed}". Both alias and email are required.`,
      );
    }

    // Restrict alias to a safe charset so it can't escape `tokenDir` via path traversal
    // (e.g. "../../etc/passwd:foo@bar.com" in .env).
    if (!/^[a-zA-Z0-9_-]+$/.test(alias) || ['__proto__', 'constructor', 'prototype'].includes(alias)) {
      throw new Error(
        `Invalid alias "${alias}". Allowed characters: letters, digits, underscore, hyphen.`,
      );
    }

    if (aliases.includes(alias)) {
      throw new Error(
        `Duplicate alias "${alias}" in GOOGLE_ACCOUNTS. Each alias must be unique.`,
      );
    }

    aliases.push(alias);
    configs[alias] = {
      email,
      ...accountPaths(alias),
      admin: adminAliases.includes(alias) || undefined,
      source: 'env',
    };
  }

  if (aliases.length === 0) {
    throw new Error('GOOGLE_ACCOUNTS must define at least one account.');
  }

  return { aliases, configs };
}

function noAccountsMessage(): string {
  const envHint =
    envLoad.loaded.length === 0
      ? ` No readable .env file was found (searched: ${envLoad.searched.join(', ')}).`
      : '';
  return (
    `no accounts configured. Add them to ${configFilePath()} (run: mcp-google-multi migrate-config), ` +
    `or set GOOGLE_ACCOUNTS=work:user@company.com,personal:user@gmail.com in the environment.${envHint}`
  );
}

/**
 * Registry resolution (BR-2): a non-empty GOOGLE_ACCOUNTS env takes the WHOLE
 * registry from env (12-factor override, never merged key-by-key); otherwise
 * the registry comes from config.json. GOOGLE_ADMIN_ACCOUNTS, when NON-EMPTY,
 * overrides per-account admin flags from the file (env var > config field);
 * empty behaves as unset, mirroring GOOGLE_ACCOUNTS semantics.
 */
let warnedLegacy = false;

export function resolveAccounts(
  env: NodeJS.ProcessEnv = process.env,
  filePath = configFilePath(),
  onInvalid: 'exit' | 'throw' = 'exit',
): AccountSet {
  const adminEnv = parseCsv(env.GOOGLE_ADMIN_ACCOUNTS);
  const rawEnv = env.GOOGLE_ACCOUNTS;

  const fail = (slug: string, message: string): never => {
    if (onInvalid === 'throw') throw new Error(`${slug}: ${message}`);
    failStartup(slug, message);
  };

  // Validate the legacy global override AT BOOT, whatever GOOGLE_TOOLSETS
  // selects — otherwise a typo only surfaces at dispatch time inside
  // account_list instead of the promised startup error (BR3).
  const legacyNames = parseCsv(env.GOOGLE_OPTIONAL_SCOPES);
  if (legacyNames.length > 0) {
    for (const bundle of resolveBundleAliases(legacyNames)) {
      if (bundle === 'admin') {
        fail(
          'E_UNKNOWN_BUNDLE',
          '"admin" is not a global bundle: grant it per account via GOOGLE_ADMIN_ACCOUNTS or an "admin: true" scope profile.',
        );
      }
      if (!(bundle in BUNDLE_CATALOG)) {
        const hint = closestBundle(bundle);
        fail(
          'E_UNKNOWN_BUNDLE',
          `unknown bundle "${bundle}" in GOOGLE_OPTIONAL_SCOPES${hint ? ` — did you mean "${hint}"?` : ''}`,
        );
      }
    }
    if (!warnedLegacy) {
      warnedLegacy = true;
      process.stderr.write(
        'E_LEGACY_GLOBAL_SCOPES: GOOGLE_OPTIONAL_SCOPES applies one global scope set to every account; migrate to per-account scopeProfiles (mcp-google-multi migrate-config).\n',
      );
    }
  }

  if (rawEnv && rawEnv.trim() !== '') {
    const { aliases, configs } = parseEnvAccounts(rawEnv, adminEnv);
    materializeFirstRun(aliases, configs, filePath);
    const def = resolveDefaultAccount(env, null, aliases, fail);
    return {
      aliases,
      configs,
      // Env-sourced accounts cannot reference file profiles; the legacy
      // GOOGLE_OPTIONAL_SCOPES override is applied live in auth.ts.
      scopeProfiles: { base: { bundles: [] } },
      source: 'env',
      stamp: 'env:0',
      ...def,
    };
  }

  // Stat BEFORE read: a cross-process write landing between the two makes the
  // stamp conservative (flags stale again next dispatch) instead of pinning
  // stale content behind a fresh stamp.
  const preStamp = fileStamp(filePath, CONFIG_VERSION);
  const config = loadConfigFile(filePath, onInvalid);
  const entries = Object.entries(config?.accounts ?? {});
  if (entries.length === 0) {
    // Gap #23: an empty registry is NOT fatal at resolve time — the bootstrap and
    // diagnostic CLIs (doctor/reset/account import/migrate-config/config check)
    // must run on a fresh install. Only the stdio/http SERVER refuses to boot
    // empty (BR-4), enforced by assertServerAccountsConfigured() in index.ts.
    // The dispatch-path reload ('throw') still throws so a mid-session emptied
    // config.json keeps the last-good registry (BR-7) instead of dropping tools.
    if (onInvalid === 'throw') {
      throw new Error(`E_NO_ACCOUNTS_CONFIGURED: ${noAccountsMessage()}`);
    }
    return {
      aliases: [],
      configs: {},
      scopeProfiles: { base: { bundles: [] } },
      source: 'file',
      stamp: `${config?.version ?? CONFIG_VERSION}:${preStamp.split(':')[1]}`,
    };
  }

  // BR3: unknown bundle names fail loudly (a mis-scoped token is worse than a
  // clear error); v5 silently filtered them. Null prototype: profile names are
  // user input and must never collide with Object.prototype members.
  const scopeProfiles: Record<string, ScopeProfile> = Object.create(null);
  scopeProfiles.base = { bundles: [] };
  for (const [name, profile] of Object.entries(config?.scopeProfiles ?? {})) {
    const bundles = resolveBundleAliases(profile.bundles);
    for (const bundle of bundles) {
      if (!(bundle in BUNDLE_CATALOG)) {
        const hint = closestBundle(bundle);
        fail(
          'E_UNKNOWN_BUNDLE',
          `unknown bundle "${bundle}" in scope profile "${name}"${hint ? ` — did you mean "${hint}"?` : ''}`,
        );
      }
    }
    if (profile.includesBase === false && bundles.length === 0 && profile.admin !== true) {
      fail(
        'E_CONFIG_INVALID',
        `scope profile "${name}" resolves to zero scopes (includesBase: false with no bundles); Google rejects an empty consent request.`,
      );
    }
    scopeProfiles[name] = { ...profile, bundles };
  }

  const configs: Record<string, AccountConfig> = {};
  const aliases: string[] = [];
  for (const [alias, entry] of entries) {
    if (entry.scopeProfile && !Object.hasOwn(scopeProfiles, entry.scopeProfile)) {
      fail(
        'E_CONFIG_INVALID',
        `account "${alias}" references scope profile "${entry.scopeProfile}", which is not defined in scopeProfiles.`,
      );
    }
    aliases.push(alias);
    configs[alias] = {
      email: entry.email,
      ...accountPaths(alias),
      scopeProfile: entry.scopeProfile,
      admin: adminEnv.length > 0 ? adminEnv.includes(alias) : entry.admin,
      source: 'config',
    };
  }

  const def = resolveDefaultAccount(env, config?.defaultAccount ?? null, aliases, fail);
  return {
    aliases,
    configs,
    scopeProfiles,
    source: 'file',
    stamp: `${config?.version ?? CONFIG_VERSION}:${preStamp.split(':')[1]}`,
    ...def,
  };
}

/** A2: env GOOGLE_DEFAULT_ACCOUNT > config.defaultAccount > unset. A configured
 * default naming an unknown alias refuses to start (E_DEFAULT_ACCOUNT_UNKNOWN —
 * deliberately NOT E_CONFIG_INVALID: the config is schema-valid). */
function resolveDefaultAccount(
  env: NodeJS.ProcessEnv,
  fromConfig: string | null,
  aliases: string[],
  fail: (slug: string, message: string) => never,
): { defaultAccount?: string; defaultAccountSource?: 'env' | 'config' } {
  const fromEnv = env.GOOGLE_DEFAULT_ACCOUNT?.trim();
  const value = fromEnv || fromConfig || undefined;
  if (!value) return {};
  if (!aliases.includes(value)) {
    fail(
      'E_DEFAULT_ACCOUNT_UNKNOWN',
      `default account "${value}" (from ${fromEnv ? 'GOOGLE_DEFAULT_ACCOUNT' : 'config.json defaultAccount'}) is not a configured alias. Valid: ${aliases.join(', ')}.`,
    );
  }
  return { defaultAccount: value, defaultAccountSource: fromEnv ? 'env' : 'config' };
}

function fileStamp(filePath: string, version: number): string {
  try {
    return `${version}:${fs.statSync(filePath).mtimeMs}`;
  } catch {
    return `${version}:0`;
  }
}

// First-run shim (BC6): env is set and no config.json exists yet — materialize
// the file so the wizard has something to edit. Env still wins this session;
// a write failure must never block boot (warn on stderr and continue).
function materializeFirstRun(
  aliases: string[],
  configs: Record<string, AccountConfig>,
  filePath: string,
): void {
  if (fs.existsSync(filePath)) return;
  try {
    let wrote = false;
    // mutateConfigFile = lock + re-check + atomic write, so a concurrent
    // wizard/migrate writer is never clobbered (the loaded `current` is
    // re-read under the lock; only a still-absent file gets the env content).
    mutateConfigFile((current) => {
      if (Object.keys(current.accounts ?? {}).length > 0) return current;
      const accounts: NonNullable<ConfigFile['accounts']> = {};
      for (const alias of aliases) {
        accounts[alias] = {
          email: configs[alias].email,
          ...(configs[alias].admin ? { admin: true } : {}),
        };
      }
      wrote = true;
      return { ...current, version: current.version || CONFIG_VERSION, accounts };
    }, filePath);
    if (wrote) {
      process.stderr.write(
        `Materialized ${filePath} from GOOGLE_ACCOUNTS (env still overrides while set).\n`,
      );
    }
  } catch (e) {
    process.stderr.write(`Could not materialize ${filePath}: ${(e as Error).message}\n`);
  }
}

let current = resolveAccounts();

/** Live accessor: dispatch-time readers use this, never a captured snapshot. */
export function getAccountSet(): AccountSet {
  return current;
}

/** Re-resolve after a config.json mutation and swap the live set. */
export function invalidateAccountSet(): AccountSet {
  current = resolveAccounts();
  return current;
}

/**
 * Dispatch-path reload (BR-7): NEVER exits and never throws — a mid-edit,
 * corrupt, or deleted config.json keeps the last-good set and warns once per
 * distinct failure on stderr. failStartup semantics are boot/CLI-only.
 */
let lastReloadWarning = '';
export function refreshAccountSetIfStale(): void {
  if (!isAccountSetStale()) return;
  try {
    current = resolveAccounts(process.env, configFilePath(), 'throw');
    lastReloadWarning = '';
  } catch (e) {
    const msg = (e as Error).message;
    if (msg !== lastReloadWarning) {
      process.stderr.write(`config.json reload skipped (keeping last-good registry): ${msg}\n`);
      lastReloadWarning = msg;
    }
  }
}

/** Cross-process staleness probe (BR-7): one stat, compared against the stamp. */
export function isAccountSetStale(): boolean {
  if (current.source !== 'file') return false;
  const [version] = current.stamp.split(':');
  return current.stamp !== fileStamp(configFilePath(), Number(version));
}

/** Account aliases (possibly empty on a fresh install).
 * Snapshot from the initial load; enums widen only when the registry is
 * rebuilt after a mutation (account_add, later slice). */
export const ACCOUNTS = current.aliases;

/**
 * The `account` param schema, empty-registry-safe. A `z.enum` requires at least
 * one value, so a fresh install (zero aliases) would throw at schema-build time
 * (module load) and take down every CLI — including `doctor`, which is meant to
 * REPORT the empty registry (gap #23). Fall back to a plain string when there
 * are no aliases: no alias exists to enumerate, the server refuses to boot empty
 * anyway, and dispatch validates the account against the live set. */
export function accountAliasSchemaFor(aliases: readonly string[]): z.ZodType<string> {
  return aliases.length > 0 ? z.enum(aliases as [string, ...string[]]) : z.string();
}

/** Shared, load-time snapshot used by every tool's `account` field. */
export const accountAliasSchema: z.ZodType<string> = accountAliasSchemaFor(ACCOUNTS);

/**
 * BR-4: the stdio/http SERVER never boots with an empty registry — a fresh user
 * bootstraps via env / `migrate-config` / `account import` / `auth` first. The
 * bootstrap and diagnostic CLIs return before this guard, so it gates only the
 * server path (called from index.ts after the CLI branches). */
export function assertServerAccountsConfigured(): void {
  if (current.aliases.length === 0) {
    failStartup('E_NO_ACCOUNTS_CONFIGURED', noAccountsMessage());
  }
}

/** Valid account alias (string union isn't static, so tools use accountAliasSchema) */
export type Account = string;
