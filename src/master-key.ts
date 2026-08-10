import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { configDir, failStartup } from './config-file.js';
import { atomicWriteFileSync, withFileLock } from './fs-atomic.js';
import { getTokenDir } from './accounts.js';

export type KeyProvenance = 'env' | 'keychain' | 'file' | 'generated';

export interface ResolvedKey {
  key: string;
  provenance: KeyProvenance;
}

interface KeychainEntry {
  get(): string | null;
  set(value: string): void;
  del(): void;
}

export interface KeyDeps {
  env?: NodeJS.ProcessEnv;
  dir?: string;
  keychain?: (account: string) => KeychainEntry | null;
  hasAnyToken?: () => boolean;
}

// The keychain is a native optionalDependency: load lazily and synchronously
// (createRequire — the token store's key read is sync), and treat EVERY
// failure (no prebuild, native load error, headless Linux without a Secret
// Service) as "keychain unavailable", falling through to the 0600 file.
const require_ = createRequire(import.meta.url);

function systemKeychain(account: string): KeychainEntry | null {
  try {
    const { Entry } = require_('@napi-rs/keyring') as {
      Entry: new (service: string, account: string) => {
        getPassword(): string;
        setPassword(v: string): void;
        deletePassword(): void;
      };
    };
    const entry = new Entry('mcp-google-multi', account);
    return {
      get: () => {
        try {
          return entry.getPassword();
        } catch {
          return null;
        }
      },
      set: (value: string) => entry.setPassword(value),
      del: () => entry.deletePassword(),
    };
  } catch {
    return null;
  }
}

// Default keychain factory, replaceable ONLY for tests: unit tests must never
// read or write the developer's real OS keyring (the BR-5 mirror once leaked a
// test fixture key into a real GNOME keyring — never again).
let keychainFactory: (account: string) => KeychainEntry | null = systemKeychain;

export function __setKeychainFactoryForTest(fn: ((account: string) => KeychainEntry | null) | null): void {
  keychainFactory = fn ?? systemKeychain;
}

// Glob the token dir instead of iterating registered aliases: an orphan .enc
// (alias removed from the registry, or a partial GOOGLE_ACCOUNTS override in
// one client) must still stop a fresh key from being minted.
function anyTokenFileExists(): boolean {
  try {
    return fs.readdirSync(getTokenDir()).some((f) => f.endsWith('.enc'));
  } catch {
    return false;
  }
}

function readKeyFile(filePath: string): string | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    try {
      const mode = fs.statSync(filePath).mode & 0o777;
      if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
        process.stderr.write(`WARN: ${filePath} is readable by others (mode ${mode.toString(8)}); chmod 600 it.\n`);
      }
    } catch {
      // stat raced a delete; the read already succeeded.
    }
    return raw;
  } catch {
    return null;
  }
}

function resolveKey(
  envName: 'MASTER_KEY' | 'MCP_JWT_KEY',
  fileName: string,
  hardGuard: boolean,
  deps: KeyDeps,
  onFail: 'exit' | 'throw' = 'exit',
): ResolvedKey {
  const env = deps.env ?? process.env;
  const dir = deps.dir ?? configDir();
  const keychain = deps.keychain ?? keychainFactory;
  const hasAnyToken = deps.hasAnyToken ?? anyTokenFileExists;

  const fail = (slug: string, message: string): never => {
    if (onFail === 'throw') throw new Error(`${slug}: ${message}`);
    failStartup(slug, message);
  };

  const fromEnv = env[envName]?.trim();
  if (fromEnv) return { key: fromEnv, provenance: 'env' };

  const entry = keychain(envName);
  const fromKeychain = entry?.get();
  if (fromKeychain) return { key: fromKeychain, provenance: 'keychain' };

  const filePath = path.join(dir, fileName);
  const fromFile = readKeyFile(filePath);
  if (fromFile) return { key: fromFile, provenance: 'file' };

  // Generate-on-setup. The hard guard is cc-security Cgen: minting a fresh
  // MASTER_KEY while <alias>.enc files exist would silently brick them all.
  if (hardGuard && hasAnyToken()) {
    fail(
      'E_MASTER_KEY_MISSING_TOKENS_EXIST',
      `no ${envName} found in env, keychain or ${filePath}, but encrypted tokens exist under ${getTokenDir()}. ` +
        'Restore the original key, or delete those .enc files and re-auth each account.',
    );
  }

  // Lock the generate critical section so two concurrent first-boots cannot
  // both mint (the loser re-reads the winner's key under the lock).
  return withFileLock(
    filePath,
    () => {
      const racedKeychain = keychain(envName)?.get();
      if (racedKeychain) return { key: racedKeychain, provenance: 'keychain' as const };
      const racedFile = readKeyFile(filePath);
      if (racedFile) return { key: racedFile, provenance: 'file' as const };

      // Exactly randomBytes(32) base64: hits deriveKey's 32-byte fast path.
      const generated = randomBytes(32).toString('base64');

      // The 0600 file is ALWAYS written: on Linux the "keychain" can be the
      // kernel keyutils keyring, which does not survive a reboot — a key that
      // lives only there bricks every token at the next boot. The file is the
      // durable sink; byte-exact read-back gates any use of the key.
      atomicWriteFileSync(filePath, `${generated}\n`, 0o600);
      if (readKeyFile(filePath) !== generated) {
        fail(
          'E_KEY_PROVISIONING_FAILED',
          `generated ${envName} could not be read back byte-exact from ${filePath}; refusing to encrypt anything with an unverified key.`,
        );
      }

      // Keychain copy is best-effort QoL; a mismatched read-back would SHADOW
      // the file on the next boot (keychain > file), so clean it up.
      let keychainNote = '';
      try {
        if (entry) {
          entry.set(generated);
          if (keychain(envName)?.get() === generated) {
            keychainNote = ' and the OS keychain (service mcp-google-multi)';
          } else {
            try {
              entry.del();
            } catch {
              process.stderr.write(`WARN: OS keychain holds a mismatched ${envName} entry; the ${fileName} file is authoritative.\n`);
            }
          }
        }
      } catch {
        // Keychain unavailable; the file already has the key.
      }
      process.stderr.write(`Generated ${envName}: stored at ${filePath} (0600)${keychainNote}.\n`);
      return { key: generated, provenance: 'generated' as const };
    },
    `${envName} provisioning`,
  );
}

let cachedMaster: ResolvedKey | null = null;
let cachedJwt: ResolvedKey | null = null;

/** BR-1 single choke point: no other module may read the env vars directly.
 * Boot/CLI form: failures exit with a clean stderr slug ("fatal at startup"). */
export function resolveMasterKey(deps?: KeyDeps): ResolvedKey {
  if (deps) return resolveKey('MASTER_KEY', 'master.key', true, deps);
  cachedMaster ??= resolveKey('MASTER_KEY', 'master.key', true, {});
  return cachedMaster;
}

/** Dispatch form: identical resolution, but failures THROW (caught by the tool
 * handler into an error envelope) — a live server is never process.exit'd. */
export function resolveMasterKeyForDispatch(): ResolvedKey {
  cachedMaster ??= resolveKey('MASTER_KEY', 'master.key', true, {}, 'throw');
  return cachedMaster;
}

/** Side-effect-free provenance probe for diagnostics: NEVER generates, never
 * fires the hard guard (config check must not mint keys or exit). */
export function peekMasterKeyProvenance(deps?: KeyDeps): KeyProvenance | 'unprovisioned' {
  const env = deps?.env ?? process.env;
  if (env.MASTER_KEY?.trim()) return 'env';
  const keychain = deps?.keychain ?? keychainFactory;
  if (keychain('MASTER_KEY')?.get()) return 'keychain';
  const dir = deps?.dir ?? configDir();
  if (readKeyFile(path.join(dir, 'master.key'))) return 'file';
  return 'unprovisioned';
}

/** MCP_JWT_KEY variant: NO hard guard — regenerating only invalidates
 * outstanding MCP tokens and clients re-auth silently. */
export function resolveJwtKey(deps?: KeyDeps): ResolvedKey {
  if (deps) return resolveKey('MCP_JWT_KEY', 'mcp-jwt.key', false, deps);
  cachedJwt ??= resolveKey('MCP_JWT_KEY', 'mcp-jwt.key', false, {});
  return cachedJwt;
}

let mirrored = false;

/**
 * BR-5: after the FIRST successful token decrypt with an env-sourced key,
 * mirror it into the keychain (only when the keychain holds no entry) so the
 * key survives an env loss. Gating on a successful decrypt means a stale or
 * wrong env key is never mirrored. Best-effort: failures are doctor material,
 * never fatal.
 */
export function noteSuccessfulDecrypt(): void {
  if (mirrored) return;
  mirrored = true;
  try {
    if (cachedMaster?.provenance !== 'env') return;
    const entry = keychainFactory('MASTER_KEY');
    if (!entry || entry.get()) return;
    entry.set(cachedMaster.key);
  } catch {
    // Keychain backend unavailable; env stays the working source.
  }
}

/** Test hook: the production cache is process-lifetime by design. */
export function clearKeyCacheForTest(): void {
  cachedMaster = null;
  cachedJwt = null;
  mirrored = false;
}
