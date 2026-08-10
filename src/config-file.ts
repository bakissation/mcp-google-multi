import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { atomicWriteFileSync, withFileLock } from './fs-atomic.js';

export const CONFIG_VERSION = 1;

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'mcp-google-multi');
}

export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), 'config.json');
}

// Alias charset is load-bearing security, not cosmetics: the alias becomes a
// tokenDir path segment (encPath), so this guard blocks path traversal.
export const ALIAS_RE = /^[a-zA-Z0-9_-]+$/;

const accountEntrySchema = z.strictObject({
  email: z.string().min(1),
  scopeProfile: z.string().optional(),
  admin: z.boolean().optional(),
});

// .strict() everywhere: any unknown or secret-shaped key (clientSecret,
// masterKey, jwtKey, clientId) fails validation, structurally enforcing
// secrets-env-only. scopeProfiles/defaultAccount/discovery/toolsets are part
// of the frozen envelope; their consumers land in later slices.
const RESERVED_ALIASES = ['__proto__', 'constructor', 'prototype'];

const configSchema = z.strictObject({
  version: z.number().int(),
  accounts: z.record(z.string().regex(ALIAS_RE), accountEntrySchema).optional(),
  scopeProfiles: z
    .record(z.string(), z.strictObject({ bundles: z.array(z.string()), admin: z.boolean().optional() }))
    .optional(),
  defaultAccount: z.string().optional(),
  discovery: z.enum(['lazy', 'curated', 'eager']).optional(),
  toolsets: z.string().optional(),
});

export interface ConfigFile {
  version: number;
  accounts?: Record<string, { email: string; scopeProfile?: string; admin?: boolean }>;
  scopeProfiles?: Record<string, { bundles: string[]; admin?: boolean }>;
  defaultAccount?: string;
  discovery?: 'lazy' | 'curated' | 'eager';
  toolsets?: string;
}

export function failStartup(slug: string, message: string): never {
  process.stderr.write(`${slug}: ${message}\n`);
  process.exit(1);
}

export class ConfigFileError extends Error {
  constructor(
    public slug: string,
    message: string,
  ) {
    super(`${slug}: ${message}`);
  }
}

/**
 * Load + validate config.json. Returns null when the file does not exist.
 * onInvalid 'exit' is for boot/CLI only; runtime reload paths use 'throw' so a
 * mid-edit or corrupt file can NEVER kill a running server (and so lock
 * finally-cleanup still runs).
 */
export function loadConfigFile(
  filePath = configFilePath(),
  onInvalid: 'exit' | 'throw' = 'exit',
): ConfigFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  function fail(slug: string, message: string): never {
    if (onInvalid === 'throw') throw new ConfigFileError(slug, message);
    failStartup(slug, message);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('E_CONFIG_INVALID', `${filePath} is not valid JSON.`);
  }
  const version = (parsed as { version?: unknown })?.version;
  if (typeof version === 'number' && version > CONFIG_VERSION) {
    fail(
      'E_CONFIG_VERSION_UNSUPPORTED',
      `${filePath} has version ${version}; this build understands up to ${CONFIG_VERSION}. Upgrade mcp-google-multi.`,
    );
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    fail(
      'E_CONFIG_INVALID',
      `${filePath}: ${issue.path.join('.') || '(root)'}: ${issue.message}. Secrets never belong in config.json.`,
    );
  }
  // Post-schema because zod's key regex passes these; a __proto__ record key
  // is a prototype-pollution foothold, not an account.
  const data = result.data as ConfigFile;
  const reserved = Object.keys(data.accounts ?? {}).find((k) => RESERVED_ALIASES.includes(k));
  if (reserved) {
    fail('E_CONFIG_INVALID', `${filePath}: accounts: reserved alias name "${reserved}".`);
  }
  return data;
}

export function writeConfigFile(config: ConfigFile, filePath = configFilePath()): void {
  atomicWriteFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 0o600);
}

/**
 * Read-latest-under-lock mutation: acquire the lock, re-read the current file,
 * apply the change to that (never a stale in-memory copy), write atomically.
 */
export function mutateConfigFile(
  fn: (current: ConfigFile) => ConfigFile,
  filePath = configFilePath(),
): ConfigFile {
  return withFileLock(
    filePath,
    () => {
      const current = loadConfigFile(filePath, 'throw') ?? { version: CONFIG_VERSION };
      const next = fn(structuredClone(current));
      writeConfigFile(next, filePath);
      return next;
    },
    'E_CONFIG_LOCK_TIMEOUT (config.json)',
  );
}
