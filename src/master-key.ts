import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { configDir, failStartup } from './config-file.js';
import { atomicWriteFileSync, withFileLock } from './fs-atomic.js';
import { getTokenDir } from './accounts.js';
import { keysWipedError, markKeysDisposed, markKeysLive, wipeBytes } from './key-material.js';

export type KeyProvenance = 'env' | 'keychain' | 'file' | 'generated';

/**
 * A resolved key. `bytes` holds the key text as UTF-8 bytes (a KeyMaterial
 * every key API accepts) and can be overwritten; `key` is the same text as a
 * string, built on each read so the resolver itself keeps no string copy.
 * `bytes` is non-enumerable: a spread or JSON.stringify sees `key` and
 * `provenance` as before.
 */
export interface ResolvedKey {
  readonly key: string;
  readonly bytes: Buffer;
  readonly provenance: KeyProvenance;
}

function resolved(bytes: Buffer, provenance: KeyProvenance): ResolvedKey {
  const r = { provenance } as { provenance: KeyProvenance; key: string; bytes: Buffer };
  Object.defineProperty(r, 'key', { enumerable: true, get: () => bytes.toString('utf8') });
  Object.defineProperty(r, 'bytes', { enumerable: false, value: bytes });
  return r;
}

interface KeychainEntry {
  get(): string | Buffer | null;
  set(value: string): void;
  del(): void;
}

export interface KeyDeps {
  env?: NodeJS.ProcessEnv;
  dir?: string;
  keychain?: (account: string) => KeychainEntry | null;
  hasAnyToken?: () => boolean;
  /** Delete the env var once the key is read, so it no longer sits in
   * process.env or a child's environment. An explicit-deps call scrubs only
   * when this is true; the setScrubKeyEnv() default applies to the cached
   * resolveMasterKey/resolveJwtKey calls alone, because only that form keeps
   * the key for the process lifetime. */
  scrubEnv?: boolean;
}

let scrubKeyEnvDefault = false;
// Names whose env var was scrubbed from process.env, so later probes still
// know the key came from there.
const scrubbedEnv = new Set<string>();

/** Process-wide default for KeyDeps.scrubEnv. Call before the first resolve. */
export function setScrubKeyEnv(on: boolean): void {
  scrubKeyEnvDefault = on;
}

// Native optionalDependency, loaded lazily and synchronously (the token
// store's key read is sync); EVERY failure falls through to the 0600 file.
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
// read or write the developer's real OS keyring.
let keychainFactory: (account: string) => KeychainEntry | null = systemKeychain;

export function __setKeychainFactoryForTest(fn: ((account: string) => KeychainEntry | null) | null): void {
  keychainFactory = fn ?? systemKeychain;
}

function anyEncFileUnder(dir: string): boolean {
  try {
    return fs.readdirSync(dir, { recursive: true }).some((f) => String(f).endsWith('.enc'));
  } catch {
    return false;
  }
}

// Globs the token dir rather than iterating registered aliases, so an orphan
// .enc still stops a fresh key from being minted. See docs/internals.md.
function anyTokenFileExists(): boolean {
  return anyEncFileUnder(getTokenDir()) || anyEncFileUnder(configDir());
}

const isAsciiWs = (b: number): boolean => b === 32 || (b >= 9 && b <= 13);

/** String.prototype.trim on bytes. ASCII content (any real key) is trimmed in
 * place with no string made; anything else takes the string route so a BOM or
 * a Unicode space is trimmed exactly as before. */
function trimKeyBytes(raw: Buffer): Buffer | null {
  if (raw.every((b) => b < 0x80)) {
    let start = 0;
    let end = raw.length;
    while (start < end && isAsciiWs(raw[start])) start++;
    while (end > start && isAsciiWs(raw[end - 1])) end--;
    if (start === end) return null;
    return Buffer.from(raw.subarray(start, end));
  }
  const text = raw.toString('utf8').trim();
  return text ? Buffer.from(text, 'utf8') : null;
}

function readKeyFile(filePath: string): Buffer | null {
  try {
    const file = fs.readFileSync(filePath);
    let trimmed: Buffer | null;
    try {
      trimmed = trimKeyBytes(file);
    } finally {
      wipeBytes(file);
    }
    if (!trimmed) return null;
    try {
      const mode = fs.statSync(filePath).mode & 0o777;
      if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
        process.stderr.write(`WARN: ${filePath} is readable by others (mode ${mode.toString(8)}); chmod 600 it.\n`);
      }
    } catch {
      // stat raced a delete; the read already succeeded.
    }
    return trimmed;
  } catch {
    return null;
  }
}

const toBytes = (v: string | Buffer): Buffer => (typeof v === 'string' ? Buffer.from(v, 'utf8') : v);

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
  if (fromEnv) {
    if (deps.scrubEnv ?? false) {
      delete env[envName];
      if (env === process.env) scrubbedEnv.add(envName);
    }
    return resolved(Buffer.from(fromEnv, 'utf8'), 'env');
  }

  const entry = keychain(envName);
  const fromKeychain = entry?.get();
  if (fromKeychain && fromKeychain.length > 0) return resolved(toBytes(fromKeychain), 'keychain');

  const filePath = path.join(dir, fileName);
  const fromFile = readKeyFile(filePath);
  if (fromFile) return resolved(fromFile, 'file');

  // Generate-on-setup. The hard guard: minting a fresh
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
      if (racedKeychain && racedKeychain.length > 0) return resolved(toBytes(racedKeychain), 'keychain');
      const racedFile = readKeyFile(filePath);
      if (racedFile) return resolved(racedFile, 'file');

      // Exactly randomBytes(32) base64: hits deriveKey's 32-byte fast path.
      const generated = randomBytes(32).toString('base64');

      // The 0600 file is ALWAYS written (some keychain backends don't survive
      // a reboot); byte-exact read-back gates any use of the key.
      atomicWriteFileSync(filePath, `${generated}\n`, 0o600);
      const readBack = readKeyFile(filePath);
      const generatedBytes = Buffer.from(generated, 'utf8');
      if (!readBack || !readBack.equals(generatedBytes)) {
        if (readBack) wipeBytes(readBack);
        wipeBytes(generatedBytes);
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
          const kcBack = keychain(envName)?.get();
          if (kcBack !== undefined && kcBack !== null && toBytes(kcBack).equals(generatedBytes)) {
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
      if (readBack) wipeBytes(readBack);
      return resolved(generatedBytes, 'generated');
    },
    `${envName} provisioning`,
  );
}

let cachedMaster: ResolvedKey | null = null;
let cachedJwt: ResolvedKey | null = null;
// Set by wipeKeyCache. The cached resolvers then refuse to resolve again: with
// the env key scrubbed they would find nothing and could mint a new master.key
// beside the operator's. rearmKeys() lifts it for a host that boots again.
let cacheWiped = false;

/** For a host that boots again in the same process after its shutdown wiped
 * the keys: lets the cached resolvers resolve afresh and the key functions
 * derive again. Buffers and holders from before the wipe stay refused. */
export function rearmKeys(): void {
  cacheWiped = false;
  markKeysLive();
}

/** Single choke point: no other module may read the env vars directly.
 * Boot/CLI form: failures exit with a clean stderr slug ("fatal at startup"). */
export function resolveMasterKey(deps?: KeyDeps): ResolvedKey {
  if (deps) return resolveKey('MASTER_KEY', 'master.key', true, deps);
  if (cacheWiped) throw keysWipedError();
  if (!cachedMaster) {
    cachedMaster = resolveKey('MASTER_KEY', 'master.key', true, { scrubEnv: scrubKeyEnvDefault });
  }
  return cachedMaster;
}

/** Dispatch form: identical resolution, but failures THROW (caught by the tool
 * handler into an error envelope) — a live server is never process.exit'd. */
export function resolveMasterKeyForDispatch(): ResolvedKey {
  if (cacheWiped) throw keysWipedError();
  if (!cachedMaster) {
    cachedMaster = resolveKey('MASTER_KEY', 'master.key', true, { scrubEnv: scrubKeyEnvDefault }, 'throw');
  }
  return cachedMaster;
}

/** Side-effect-free provenance probe for diagnostics: NEVER generates, never
 * fires the hard guard (config check must not mint keys or exit). */
export function peekMasterKeyProvenance(deps?: KeyDeps): KeyProvenance | 'unprovisioned' {
  const env = deps?.env ?? process.env;
  if (env.MASTER_KEY?.trim()) return 'env';
  // Scrubbed from process.env after the cached read: the key still came from there.
  if (!deps?.env && cachedMaster?.provenance === 'env') return 'env';
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
  if (cacheWiped) throw keysWipedError();
  if (!cachedJwt) {
    cachedJwt = resolveKey('MCP_JWT_KEY', 'mcp-jwt.key', false, { scrubEnv: scrubKeyEnvDefault });
  }
  return cachedJwt;
}

let mirrored = false;

/**
 * After the FIRST successful token decrypt with an env-sourced key,
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

/** Reset: drop the generated MASTER_KEY material (0600 file + keychain
 * entry) so the next run re-provisions. Never removes an env-provided key (the
 * deployer owns that; `env:true` flags it so reset can warn). The caller MUST
 * have wiped every .enc token first — regenerating with tokens present would
 * brick them (enforced by the reset planner). */
export function deleteMasterKeyMaterial(deps?: { dir?: string; keychain?: (a: string) => KeychainEntry | null }): { file: boolean; keychain: boolean; env: boolean } {
  const dir = deps?.dir ?? configDir();
  const keychain = deps?.keychain ?? keychainFactory;
  const env = Boolean(process.env.MASTER_KEY?.trim()) || scrubbedEnv.has('MASTER_KEY');
  let file = false;
  let kc = false;
  try {
    fs.unlinkSync(path.join(dir, 'master.key'));
    file = true;
  } catch {
    // already absent
  }
  try {
    const entry = keychain('MASTER_KEY');
    if (entry && entry.get()) {
      entry.del();
      kc = true;
    }
  } catch {
    // keychain unavailable
  }
  // A scrubbed env key lives only in this cache; dropping it would lose the key.
  if (!scrubbedEnv.has('MASTER_KEY')) cachedMaster = null;
  return { file, keychain: kc, env };
}

/** Shutdown: overwrite the cached key bytes and drop the cache. A ResolvedKey
 * handed out earlier shares those bytes, so it is overwritten too and fails
 * closed. A key that was scrubbed from the env cannot be read again after
 * this; call it only when the process is going away. */
export function wipeKeyCache(): void {
  for (const k of [cachedMaster, cachedJwt]) if (k) wipeBytes(k.bytes);
  cachedMaster = null;
  cachedJwt = null;
  cacheWiped = true;
  markKeysDisposed();
}

/** Test hook: the production cache is process-lifetime by design. */
export function clearKeyCacheForTest(): void {
  cachedMaster = null;
  cachedJwt = null;
  mirrored = false;
  scrubbedEnv.clear();
  scrubKeyEnvDefault = false;
  cacheWiped = false;
  markKeysLive();
}
