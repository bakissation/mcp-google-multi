import * as fs from 'fs';
import * as path from 'path';
import { stringifyEnvelope } from './_errors.js';
import { configDir } from '../config-file.js';
import { getTokenDir } from '../accounts.js';

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
  constructor(public readonly reason: 'not_absolute' | 'forbidden' | 'exists', message: string) {
    super(message);
    this.name = 'LocalFileError';
  }
}

/** Standard envelope for a LocalFileError, shared so Drive and Gmail's
 * host-file tools render the same shape instead of each inventing one. */
export function localFileErrorResult(error: LocalFileError, account: string | undefined) {
  const code = error.reason === 'not_absolute' ? 'local_path_not_absolute' : error.reason === 'exists' ? 'local_path_exists' : 'local_path_forbidden';
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
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
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

/**
 * One policy for every host-file tool (Drive upload/update/download/export,
 * Gmail attachments/downloads): the path must be absolute, and must not
 * resolve, after symlinks, inside the server's own config/token
 * directory (master.key, tokens/*.enc, mcp-tokens.enc). `kind: 'read'`
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
  if (!path.isAbsolute(targetPath)) {
    throw new LocalFileError('not_absolute', `local path must be absolute: ${targetPath}`);
  }
  const realPath = kind === 'read' ? await fs.promises.realpath(targetPath) : await realpathDeepestExisting(targetPath);
  const denied = [configDir(), getTokenDir()];
  for (const dir of denied) {
    if (await isInsideRealDir(dir, realPath)) {
      throw new LocalFileError(
        'forbidden',
        `refusing to ${kind} a path inside the server's config/token directory: ${path.basename(targetPath)}`,
      );
    }
  }
  return realPath;
}

/** True when GOOGLE_LOCAL_FILES=off, the operator switch that removes every
 * host-file tool/param regardless of context (see compose.ts). */
export function localFilesDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GOOGLE_LOCAL_FILES === 'off';
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
  await assertLocalPathAllowed(dir, 'write');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, name);
  if (fs.existsSync(dest)) {
    throw new LocalFileError('exists', `refusing to overwrite an existing file: ${dest}`);
  }
  return dest;
}

// createReadStream's open failure surfaces as an unhandled 'error' event that
// kills the process; opening the fd first turns it into a normal rejection.
export async function openLocalReadStream(localPath: string): Promise<fs.ReadStream> {
  const realPath = await assertLocalPathAllowed(localPath, 'read');
  const handle = await fs.promises.open(realPath, 'r');
  // open() succeeds on a directory; fail it here rather than as an async read error.
  if ((await handle.stat()).isDirectory()) {
    await handle.close();
    throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${localPath}'`), {
      code: 'EISDIR',
      path: localPath,
    });
  }
  const stream = handle.createReadStream();
  // Mid-read errors still reach the consumer through its own listeners; this
  // one only closes the unhandled-'error' crash path.
  stream.on('error', () => {});
  return stream;
}
