import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 20;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Hardlink-based advisory lock, generalized path-keyed from the token store's
// alias-keyed original (same mechanics: dead-owner recovery via signal-0 probe,
// EPERM = alive, corrupt lock content recovered as dead, 5s timeout).
export function withFileLock<T>(absPath: string, fn: () => T, label = `lock: ${absPath}`): T {
  const dir = path.dirname(absPath);
  const lock = path.join(dir, `.${path.basename(absPath)}.lock`);
  const ownerFile = `${lock}.${process.pid}.${randomBytes(6).toString('hex')}.owner`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(ownerFile, String(process.pid), { mode: 0o600, flag: 'wx' });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  try {
    while (true) {
      try {
        fs.linkSync(ownerFile, lock);
        break;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'EEXIST') throw error;
        try {
          const observedOwner = fs.readFileSync(lock, 'utf8');
          const owner = Number(observedOwner);
          let ownerDead = !(Number.isSafeInteger(owner) && owner > 0);
          if (!ownerDead) {
            try {
              process.kill(owner, 0);
            } catch (ownerError) {
              const code = (ownerError as NodeJS.ErrnoException).code;
              // EPERM: PID exists but is not signalable (recycled by another
              // user); treat as alive, never break a lock we cannot verify.
              if (code === 'ESRCH') ownerDead = true;
              else if (code !== 'EPERM') throw ownerError;
            }
          }
          if (ownerDead) {
            if (fs.readFileSync(lock, 'utf8') === observedOwner) fs.rmSync(lock, { force: true });
            continue;
          }
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === 'ENOENT') {
            continue;
          }
          throw readError;
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for ${label}`, { cause: error });
        }
        sleep(LOCK_RETRY_MS);
      }
    }
  } finally {
    fs.rmSync(ownerFile, { force: true });
  }

  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

export function atomicWriteFileSync(absPath: string, contents: string, mode = 0o600): void {
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(absPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, contents, { mode, flag: 'wx' });
    // Open read-write, not read-only: on Windows fsync maps to
    // FlushFileBuffers, which returns EPERM on a read-only handle.
    const fd = fs.openSync(tmp, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameWithRetry(tmp, absPath);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // force only suppresses ENOENT; a Windows handle-holder can make this
      // throw and mask the real write error. The orphan tmp is harmless.
    }
  }
}

// Windows only: renaming over a momentarily-open file throws transient EPERM/EACCES/EBUSY (reads take no lock); see docs/internals.md.
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!transient || attempt >= RENAME_ATTEMPTS) throw error;
      sleep(RENAME_RETRY_MS * attempt);
    }
  }
}

export function atomicWriteWithLock(absPath: string, contents: string, mode = 0o600): void {
  withFileLock(absPath, () => atomicWriteFileSync(absPath, contents, mode));
}
