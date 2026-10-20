import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  openLocalReadStream,
  prepareLocalDest,
  assertLocalPathAllowed,
  localFilesDisabledByEnv,
  LocalFileError,
} from '../src/tools/_local-files.js';
import { configDir } from '../src/config-file.js';
import { getTokenDir } from '../src/accounts.js';

describe('openLocalReadStream', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const p of created.splice(0)) fs.rmSync(p, { recursive: true, force: true });
  });

  function tmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gm-lf-'));
    created.push(dir);
    return dir;
  }

  it('streams an existing file', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'payload.txt');
    fs.writeFileSync(file, 'hello stream');

    const stream = await openLocalReadStream(file);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hello stream');
  });

  // Regression: fs.createReadStream() on a missing path emits an unlistened
  // async 'error' event that kills the process. The helper must reject instead.
  it('rejects with ENOENT for a missing path (never an async event)', async () => {
    const missing = path.join(tmpDir(), 'nope', 'missing.bin');
    await expect(openLocalReadStream(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects with EISDIR for a directory path', async () => {
    const dir = tmpDir();
    await expect(openLocalReadStream(dir)).rejects.toMatchObject({ code: 'EISDIR', path: dir });
  });

  it('attaches an error listener so late stream errors cannot crash the process', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'payload.txt');
    fs.writeFileSync(file, 'x');

    const stream = await openLocalReadStream(file);
    expect(stream.listenerCount('error')).toBeGreaterThanOrEqual(1);
    stream.destroy(new Error('late failure'));
    // Nothing to assert beyond survival: an unhandled 'error' would fail the run.
    await new Promise((r) => setTimeout(r, 10));
  });

  // GHSA-vc23-xv43-mfh3 part 1: before this fix, Drive's openLocalReadStream
  // had no confinement check at all (only Gmail's attachment path did). Same
  // assertion as tests/attachment-guards.test.ts, now proving the two
  // surfaces share one policy instead of two that can drift.
  it('refuses a read inside the server config/token dir (secret-exfil guard)', async () => {
    const dir = configDir();
    fs.mkdirSync(dir, { recursive: true });
    const secret = path.join(dir, 'master.key');
    fs.writeFileSync(secret, 'SECRETKEY');
    await expect(openLocalReadStream(secret)).rejects.toMatchObject({ reason: 'forbidden' });
  });

  it('refuses a read of a token file via the token dir, even outside configDir', async () => {
    const dir = getTokenDir();
    fs.mkdirSync(dir, { recursive: true });
    const token = path.join(dir, 'work.enc');
    fs.writeFileSync(token, 'ENCRYPTED');
    await expect(openLocalReadStream(token)).rejects.toMatchObject({ reason: 'forbidden' });
  });

  it.skipIf(process.platform === 'win32')('refuses a symlink that resolves into the config dir (realpath before check)', async () => {
    const dir = configDir();
    fs.mkdirSync(dir, { recursive: true });
    const secret = path.join(dir, 'tokenlink-target.key');
    fs.writeFileSync(secret, 'SECRET');
    const link = path.join(tmpDir(), 'innocent.txt');
    fs.symlinkSync(secret, link);
    await expect(openLocalReadStream(link)).rejects.toMatchObject({ reason: 'forbidden' });
  });

  it('rejects a relative path outright', async () => {
    await expect(openLocalReadStream('relative/file.txt')).rejects.toMatchObject({ reason: 'not_absolute' });
  });
});

describe('assertLocalPathAllowed', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const p of created.splice(0)) fs.rmSync(p, { recursive: true, force: true });
  });
  function tmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gm-lf-assert-'));
    created.push(dir);
    return dir;
  }

  it('rejects a relative path for both read and write', async () => {
    await expect(assertLocalPathAllowed('rel/path.txt', 'read')).rejects.toMatchObject({ reason: 'not_absolute' });
    await expect(assertLocalPathAllowed('rel/path.txt', 'write')).rejects.toMatchObject({ reason: 'not_absolute' });
  });

  it('a write target resolves even when none of its directories exist yet', async () => {
    const parent = tmpDir();
    const target = path.join(parent, 'a', 'b', 'report.pdf');
    const real = await assertLocalPathAllowed(target, 'write');
    expect(path.resolve(real)).toBe(path.resolve(target));
    // resolving must not have a side effect of creating anything.
    expect(fs.existsSync(path.join(parent, 'a'))).toBe(false);
  });

  // GHSA-vc23-xv43-mfh3's write side: a symlinked ANCESTOR directory (not the
  // leaf, which does not exist yet) must not be able to smuggle a write past
  // the config-dir guard. realpathDeepestExisting resolves the deepest
  // existing ancestor, which IS the symlink here, before the confinement check.
  it.skipIf(process.platform === 'win32')('refuses a write whose not-yet-existing path descends through a symlinked ancestor pointing at the config dir', async () => {
    const dir = configDir();
    fs.mkdirSync(dir, { recursive: true });
    const parent = tmpDir();
    const link = path.join(parent, 'alias');
    fs.symlinkSync(dir, link);
    const target = path.join(link, 'subdir', 'exfiltrated.bin');
    await expect(assertLocalPathAllowed(target, 'write')).rejects.toMatchObject({ reason: 'forbidden' });
  });

  it('allows a normal write target outside the config/token dirs', async () => {
    const parent = tmpDir();
    const target = path.join(parent, 'out', 'report.pdf');
    await expect(assertLocalPathAllowed(target, 'write')).resolves.toBe(path.resolve(target));
  });
});

describe('prepareLocalDest overwrite protection', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const p of created.splice(0)) fs.rmSync(p, { recursive: true, force: true });
  });
  function tmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gm-lf-dest-'));
    created.push(dir);
    return dir;
  }

  // Advisory part 2, proposed fix #4: downloads must never silently clobber
  // whatever is already at the destination (attacker-influenced content
  // landing on a path the caller did not necessarily expect to be replaced).
  it('refuses to overwrite a file that already exists at the destination', async () => {
    const dir = tmpDir();
    const existing = path.join(dir, 'report.pdf');
    fs.writeFileSync(existing, 'already here');
    await expect(prepareLocalDest(dir, 'report.pdf')).rejects.toMatchObject({ reason: 'exists' });
    // and the existing file must be untouched
    expect(fs.readFileSync(existing, 'utf8')).toBe('already here');
  });

  it('still succeeds for a destination that does not exist yet', async () => {
    const dir = tmpDir();
    const dest = await prepareLocalDest(dir, 'fresh.pdf');
    expect(dest).toBe(path.join(dir, 'fresh.pdf'));
    expect(fs.existsSync(dest)).toBe(false); // prepareLocalDest only resolves the path, it does not write
  });

  it('refuses a download destination inside the config/token dir, same policy as the read side', async () => {
    const dir = configDir();
    fs.mkdirSync(dir, { recursive: true });
    await expect(prepareLocalDest(dir, 'master.key')).rejects.toMatchObject({ reason: 'forbidden' });
  });
});

describe('localFilesDisabledByEnv (GOOGLE_LOCAL_FILES=off)', () => {
  it('is only true for the literal value "off"', () => {
    expect(localFilesDisabledByEnv({})).toBe(false);
    expect(localFilesDisabledByEnv({ GOOGLE_LOCAL_FILES: 'true' })).toBe(false);
    expect(localFilesDisabledByEnv({ GOOGLE_LOCAL_FILES: 'Off' })).toBe(false);
    expect(localFilesDisabledByEnv({ GOOGLE_LOCAL_FILES: 'off' })).toBe(true);
  });
});
