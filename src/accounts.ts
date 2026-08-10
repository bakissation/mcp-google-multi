import path from 'node:path';
import fs from 'node:fs';
import { loadEnvFiles } from './env-load.js';
import { CONFIG_VERSION, configDir, configFilePath, failStartup, loadConfigFile, mutateConfigFile } from './config-file.js';
import type { ConfigFile } from './config-file.js';

const envLoad = loadEnvFiles();

const defaultTokenDir = path.join(configDir(), 'tokens');
const tokenDir = process.env.TOKEN_STORE_PATH
  ? path.resolve(process.env.TOKEN_STORE_PATH)
  : defaultTokenDir;

export interface AccountConfig {
  email: string;
  tokenPath: string;
  encPath: string;
  scopeProfile?: string;
  admin?: boolean;
  source: 'config' | 'env';
}

export interface AccountSet {
  aliases: [string, ...string[]];
  configs: Record<string, AccountConfig>;
  source: 'env' | 'file' | 'merged';
  stamp: string;
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
export function resolveAccounts(
  env: NodeJS.ProcessEnv = process.env,
  filePath = configFilePath(),
  onInvalid: 'exit' | 'throw' = 'exit',
): AccountSet {
  const adminEnv = parseCsv(env.GOOGLE_ADMIN_ACCOUNTS);
  const rawEnv = env.GOOGLE_ACCOUNTS;

  if (rawEnv && rawEnv.trim() !== '') {
    const { aliases, configs } = parseEnvAccounts(rawEnv, adminEnv);
    materializeFirstRun(aliases, configs, filePath);
    return {
      aliases: aliases as [string, ...string[]],
      configs,
      source: 'env',
      stamp: 'env:0',
    };
  }

  // Stat BEFORE read: a cross-process write landing between the two makes the
  // stamp conservative (flags stale again next dispatch) instead of pinning
  // stale content behind a fresh stamp.
  const preStamp = fileStamp(filePath, CONFIG_VERSION);
  const config = loadConfigFile(filePath, onInvalid);
  const entries = Object.entries(config?.accounts ?? {});
  if (entries.length === 0) {
    if (onInvalid === 'throw') {
      throw new Error(`E_NO_ACCOUNTS_CONFIGURED: ${noAccountsMessage()}`);
    }
    failStartup('E_NO_ACCOUNTS_CONFIGURED', noAccountsMessage());
  }

  const configs: Record<string, AccountConfig> = {};
  const aliases: string[] = [];
  for (const [alias, entry] of entries) {
    aliases.push(alias);
    configs[alias] = {
      email: entry.email,
      ...accountPaths(alias),
      scopeProfile: entry.scopeProfile,
      admin: adminEnv.length > 0 ? adminEnv.includes(alias) : entry.admin,
      source: 'config',
    };
  }

  return {
    aliases: aliases as [string, ...string[]],
    configs,
    source: 'file',
    stamp: `${config?.version ?? CONFIG_VERSION}:${preStamp.split(':')[1]}`,
  };
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

/** Tuple of account aliases (at least one) — usable with z.enum().
 * Snapshot from the initial load; enums widen only when the registry is
 * rebuilt after a mutation (account_add, later slice). */
export const ACCOUNTS = current.aliases;

/** Valid account alias (string union isn't static, so tools use z.enum(ACCOUNTS)) */
export type Account = string;
