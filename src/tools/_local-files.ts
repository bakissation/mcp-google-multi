import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { stringifyEnvelope } from './_errors.js';
import { configDir } from '../config-file.js';
import { getTokenDir } from '../accounts.js';
import { discoveryCacheDir } from '../discovery-client.js';
import { getLoadedEnvFiles } from '../env-load.js';

/** Refusal for a host-file argument on a context that may not touch the
 * server's disk: the host belongs to its operator, not to every caller. */
export function hostFilesRefused(account: string | undefined, what: string) {
  return {
    content: [{
      type: 'text' as const,
      text: stringifyEnvelope({
        error: 'forbidden',
        message: `${what}: this caller may not read files on the machine running the server.`,
        hint: 'Put the file in Drive first and work from its Drive id.',
        retriable: false,
        account,
      }),
    }],
    isError: true as const,
  };
}

/** Thrown by assertLocalPathAllowed. `reason` lets each tool render its own
 * wording (Gmail's E_ATTACHMENT_FORBIDDEN vs Drive's generic envelope)
 * without re-deriving the policy that produced it. */
export class LocalFileError extends Error {
  constructor(public readonly reason: 'forbidden' | 'exists', message: string) {
    super(message);
    this.name = 'LocalFileError';
  }
}

/** Standard envelope for a LocalFileError, shared so Drive and Gmail's
 * host-file tools render the same shape instead of each inventing one. */
export function localFileErrorResult(error: LocalFileError, account: string | undefined) {
  const code = error.reason === 'exists' ? 'local_path_exists' : 'local_path_forbidden';
  return {
    content: [{
      type: 'text' as const,
      text: stringifyEnvelope({
        error: code,
        message: error.message,
        retriable: false,
        account,
      }),
    }],
    isError: true as const,
  };
}

// path.basename() is a traversal guard: a caller-supplied filename must never escape savePath.
function sanitizedName(filename: string): string {
  return path.basename(filename);
}

// Case-insensitive on win32 (drive-letter/casing differences otherwise make
// path.relative report "outside" for the same directory).
function isInside(dir: string, target: string): boolean {
  let d = path.resolve(dir);
  let t = path.resolve(target);
  if (process.platform === 'win32') {
    d = d.toLowerCase();
    t = t.toLowerCase();
  }
  const rel = path.relative(d, t);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  // A real escape is exactly ".." (target is dir's parent) or starts with
  // "../" (target is outside, via an ancestor); a leaf merely NAMED with
  // leading dots (e.g. "..notes.txt", directly inside `dir`) is not an
  // escape, even though the string also starts with the two characters "..".
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/** Deny if realTarget resolves inside `dir` (both realpath'd so a symlinked
 * dir or 8.3/extended-prefix form can't slip past). */
async function isInsideRealDir(dir: string, realTarget: string): Promise<boolean> {
  let realDir: string;
  try {
    realDir = await fs.promises.realpath(dir);
  } catch {
    return false; // dir does not exist → target cannot be inside it
  }
  return isInside(realDir, realTarget);
}

/** Deny if realTarget IS one of `files` (both realpath'd: a symlink to a
 * loaded .env file is the same secret source as the file itself). */
async function isOneOfRealFiles(files: readonly string[], realTarget: string): Promise<boolean> {
  for (const f of files) {
    try {
      if ((await fs.promises.realpath(f)) === realTarget) return true;
    } catch {
      // the .env file this process loaded earlier no longer exists: nothing to match
    }
  }
  return false;
}

/** realpath of the deepest EXISTING ancestor of `targetPath`, with the
 * still-nonexistent tail (if any) reattached literally. A write target's
 * leaf file, and sometimes several of its parent directories, do not exist
 * yet, so plain realpath would just throw ENOENT; this resolves every
 * component that DOES exist, so a symlinked ancestor directory cannot
 * smuggle the eventual write past the confinement check below. */
async function realpathDeepestExisting(targetPath: string): Promise<string> {
  let current = targetPath;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await fs.promises.realpath(current);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err; // reached the root and it's still missing
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** GOOGLE_LOCAL_FILES_DIR, or its default, resolved but not yet checked for
 * existence. `homedir` is a test-only override (see ensureLocalFilesRoot). */
export function localFilesRoot(env: NodeJS.ProcessEnv = process.env, homedir: () => string = os.homedir): string {
  const raw = env.GOOGLE_LOCAL_FILES_DIR;
  return raw && raw.trim() !== '' ? path.resolve(raw.trim()) : path.join(homedir(), 'Downloads', 'mcp-google-multi');
}

let loggedRoot: string | undefined;

/** Logs the configured (or default) root once per process, WITHOUT
 * creating it. Safe to call eagerly at startup (and from `config check`):
 * the root itself is created lazily, only on the first actual host-file
 * use (see ensureLocalFilesRoot), so a read-only or missing HOME at boot
 * (hardened systemd, an isolated service user) can never fail server
 * startup over a feature that might never be used this run. */
export function logLocalFilesRootAtStartup(env: NodeJS.ProcessEnv = process.env, homedir: () => string = os.homedir): void {
  try {
    const root = localFilesRoot(env, homedir);
    if (loggedRoot !== root) {
      loggedRoot = root;
      process.stderr.write(`Host-file tools (uploads, downloads, attachments), when used, are confined to: ${root}\n`);
    }
  } catch {
    // Best-effort only: never let a log line fail startup.
  }
}

/** Resolves GOOGLE_LOCAL_FILES_DIR (or its default) and creates it (mode
 * 0700, owner-only) if missing. Called lazily, from assertLocalPathAllowed
 * only, on the first actual host-file use, never at startup: mkdir can
 * fail (a read-only or missing HOME, the root already existing as a plain
 * file), and that failure must surface as an ordinary refused tool call,
 * not an uncaught throw out of request handling. */
export function ensureLocalFilesRoot(env: NodeJS.ProcessEnv = process.env, homedir: () => string = os.homedir): string {
  const root = localFilesRoot(env, homedir);
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new LocalFileError(
      'forbidden',
      `could not create or access the local-files root (${root}): ${(err as Error).message}`,
    );
  }
  if (loggedRoot !== root) {
    loggedRoot = root;
    process.stderr.write(`Host-file tools (uploads, downloads, attachments) are confined to: ${root}\n`);
  }
  return root;
}

/**
 * One policy for every host-file tool (Drive upload/update/download/export,
 * Gmail attachments/downloads). A path must resolve, after symlinks, INSIDE
 * GOOGLE_LOCAL_FILES_DIR (or its default, ~/Downloads/mcp-google-multi): a
 * relative path (or filename) resolves inside that root, an absolute one
 * must already be inside it. On top of the root, as defense in depth for a
 * root configured too wide (e.g. $HOME), the path must also not resolve
 * inside the server's own config/token directory (master.key, tokens/*.enc,
 * mcp-tokens.enc), the Discovery cache dir, or /proc (which includes
 * /proc/self/environ: the process's own environment, holding the same
 * secrets a .env file does), nor BE one of the .env files this process
 * actually loaded a secret from, wherever they live. `kind: 'read'`
 * requires the path to exist (realpath resolves it directly, so a missing
 * file's ENOENT surfaces unchanged to the caller); `kind: 'write'` only
 * needs some leading portion to exist yet, so it resolves the deepest
 * existing ancestor instead (see realpathDeepestExisting).
 *
 * Returns the resolved real path: callers should perform the actual I/O
 * against IT, not the caller-supplied one, so a symlink swapped in after
 * this check cannot redirect the operation.
 */
export async function assertLocalPathAllowed(targetPath: string, kind: 'read' | 'write'): Promise<string> {
  const root = ensureLocalFilesRoot();
  const absolute = path.isAbsolute(targetPath) ? targetPath : path.join(root, targetPath);
  const realPath = kind === 'read' ? await fs.promises.realpath(absolute) : await realpathDeepestExisting(absolute);

  if (!(await isInsideRealDir(root, realPath))) {
    throw new LocalFileError(
      'forbidden',
      `refusing to ${kind} a path outside the allowed local-files root (${root}): ${path.basename(targetPath)}`,
    );
  }

  const deniedDirs = [configDir(), getTokenDir(), discoveryCacheDir(), '/proc'];
  for (const dir of deniedDirs) {
    if (await isInsideRealDir(dir, realPath)) {
      throw new LocalFileError(
        'forbidden',
        `refusing to ${kind} a path inside the server's config/token/cache directory, or /proc: ${path.basename(targetPath)}`,
      );
    }
  }
  if (await isOneOfRealFiles(getLoadedEnvFiles(), realPath)) {
    throw new LocalFileError(
      'forbidden',
      `refusing to ${kind} a .env file this server loaded secrets from: ${path.basename(targetPath)}`,
    );
  }
  return realPath;
}

const LOCAL_FILES_OFF = new Set(['off', '0', 'false', 'no']);
const LOCAL_FILES_ON = new Set(['on', '1', 'true', 'yes']);

/** True when GOOGLE_LOCAL_FILES is set to an off-synonym (off|0|false|no,
 * any case, the same switch parsing as GOOGLE_USAGE_METRICS), the operator
 * switch that removes every host-file tool/param regardless of context
 * (see compose.ts). Unset (or empty) leaves host files at their default
 * (enabled). An unrecognised non-empty value fails CLOSED (treated as
 * off), with a warning: a typo in a security-relevant switch must narrow
 * the surface, not silently widen it the way GOOGLE_USAGE_METRICS's own
 * fail-open-to-its-default is fine to for a telemetry switch. */
export function localFilesDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.GOOGLE_LOCAL_FILES;
  if (raw === undefined || raw.trim() === '') return false;
  const v = raw.trim().toLowerCase();
  if (LOCAL_FILES_OFF.has(v)) return true;
  if (LOCAL_FILES_ON.has(v)) return false;
  process.stderr.write(`GOOGLE_LOCAL_FILES="${raw}" is not a valid value (off|0|false|no / on|1|true|yes); host-file tools are disabled (fail closed)\n`);
  return true;
}

/** Resolve and validate a download/export destination directory, then
 * create it if missing. Refuses to overwrite an existing file: downloads
 * are attacker-influenced content (a shared Drive file, an inbound
 * attachment), so clobbering whatever is already at that path silently is
 * never the right default. */
export async function prepareLocalDest(savePath: string, filename: string): Promise<string> {
  const name = sanitizedName(filename);
  // Agents routinely repeat the leaf in both savePath and filename; a blind
  // join would bury the download in a directory named like the file itself.
  const dir = path.basename(savePath) === name ? path.dirname(savePath) : savePath;
  // Write through the SAME resolved real path that was just checked, not
  // the caller-supplied one: re-deriving the destination from `dir` again
  // here would let a symlink swapped in between the check and this mkdir
  // (TOCTOU) redirect the eventual write past the check that just ran.
  const realDir = await assertLocalPathAllowed(dir, 'write');
  fs.mkdirSync(realDir, { recursive: true });
  const dest = path.join(realDir, name);
  if (fs.existsSync(dest)) {
    throw new LocalFileError('exists', `refusing to overwrite an existing file: ${dest}`);
  }
  return dest;
}

// createReadStream's open failure surfaces as an unhandled 'error' event that
// kills the process; opening the fd first turns it into a normal rejection.
async function openFdReadStream(absolutePath: string): Promise<fs.ReadStream> {
  const handle = await fs.promises.open(absolutePath, 'r');
  // open() succeeds on a directory; fail it here rather than as an async read error.
  if ((await handle.stat()).isDirectory()) {
    await handle.close();
    throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${absolutePath}'`), {
      code: 'EISDIR',
      path: absolutePath,
    });
  }
  const stream = handle.createReadStream();
  // Mid-read errors still reach the consumer through its own listeners; this
  // one only closes the unhandled-'error' crash path.
  stream.on('error', () => {});
  return stream;
}

/**
 * Reads a path the SERVER itself created and fully controls (e.g.
 * drive_transfer's download+upload fallback staging a file under
 * os.tmpdir() before re-uploading it): this is not a caller-supplied
 * argument, so it must not go through assertLocalPathAllowed. The
 * GOOGLE_LOCAL_FILES_DIR root is an allow-list for host-file TOOL
 * arguments (localPath/savePath/attachment paths); the server's own
 * internal plumbing is not one of those, and must not even have the side
 * effect of creating that root (it may not exist, GOOGLE_LOCAL_FILES may
 * be off, or the caller may not be the owner; none of that should matter
 * for a file the server made for itself and will delete when done).
 */
export async function openInternalReadStream(absolutePath: string): Promise<fs.ReadStream> {
  return openFdReadStream(absolutePath);
}

export async function openLocalReadStream(localPath: string): Promise<fs.ReadStream> {
  const realPath = await assertLocalPathAllowed(localPath, 'read');
  return openFdReadStream(realPath);
}
