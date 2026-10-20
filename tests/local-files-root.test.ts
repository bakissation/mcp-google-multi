import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assertLocalPathAllowed,
  localFilesRoot,
  ensureLocalFilesRoot,
  openLocalReadStream,
  openInternalReadStream,
  prepareLocalDest,
} from '../src/tools/_local-files.js';
import { configDir } from '../src/config-file.js';

// The real path, not os.tmpdir(): on Windows tmpdir() can be an 8.3 short
// name (RUNNER~1) while the guard returns the resolved long path.
const TMP = fs.realpathSync.native(os.tmpdir());

// GOOGLE_LOCAL_FILES_DIR: an allow-list root for every host-file read and
// write. tests/setup.ts pins it to os.tmpdir() for the rest of the suite;
// these tests override it locally to a narrow, disposable root so "outside
// the root" has somewhere real to point to.
describe('GOOGLE_LOCAL_FILES_DIR allow-list root', () => {
  const created: string[] = [];
  const priorRoot = process.env.GOOGLE_LOCAL_FILES_DIR;
  afterEach(() => {
    if (priorRoot === undefined) delete process.env.GOOGLE_LOCAL_FILES_DIR;
    else process.env.GOOGLE_LOCAL_FILES_DIR = priorRoot;
    for (const p of created.splice(0)) fs.rmSync(p, { recursive: true, force: true });
  });

  function freshRoot(): string {
    const dir = fs.mkdtempSync(path.join(TMP, 'mcp-gm-root-'));
    created.push(dir);
    process.env.GOOGLE_LOCAL_FILES_DIR = dir;
    return dir;
  }

  function outsideDir(): string {
    const dir = fs.mkdtempSync(path.join(TMP, 'mcp-gm-outside-'));
    created.push(dir);
    return dir;
  }

  it('a read path outside the root is refused', async () => {
    freshRoot();
    const outside = outsideDir();
    const secret = path.join(outside, 'not-yours.txt');
    fs.writeFileSync(secret, 'x');
    await expect(assertLocalPathAllowed(secret, 'read')).rejects.toMatchObject({ reason: 'forbidden' });
  });

  it('a write path outside the root is refused, even when none of it exists yet', async () => {
    freshRoot();
    const outside = outsideDir();
    const target = path.join(outside, 'a', 'b', 'new.bin');
    await expect(assertLocalPathAllowed(target, 'write')).rejects.toMatchObject({ reason: 'forbidden' });
  });

  it('drive_upload-style read and gmail-attachment-style read both honour the root (via openLocalReadStream)', async () => {
    freshRoot();
    const outside = outsideDir();
    const secret = path.join(outside, 'exfil.bin');
    fs.writeFileSync(secret, 'x');
    await expect(openLocalReadStream(secret)).rejects.toMatchObject({ reason: 'forbidden' });
  });

  it('drive_download-style write both honours the root (via prepareLocalDest)', async () => {
    freshRoot();
    const outside = outsideDir();
    await expect(prepareLocalDest(outside, 'report.pdf')).rejects.toMatchObject({ reason: 'forbidden' });
  });

  it.skipIf(process.platform === 'win32')('a symlink inside the root pointing outside it is refused (realpath before the containment check)', async () => {
    const root = freshRoot();
    const outside = outsideDir();
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'x');
    const link = path.join(root, 'looks-local.txt');
    fs.symlinkSync(secret, link);
    await expect(assertLocalPathAllowed(link, 'read')).rejects.toMatchObject({ reason: 'forbidden' });
  });

  it.skipIf(process.platform === 'win32')('a symlinked ancestor directory inside the root pointing outside it is refused for a write target', async () => {
    const root = freshRoot();
    const outside = outsideDir();
    const link = path.join(root, 'alias');
    fs.symlinkSync(outside, link);
    const target = path.join(link, 'subdir', 'new.bin');
    await expect(assertLocalPathAllowed(target, 'write')).rejects.toMatchObject({ reason: 'forbidden' });
  });

  it('a relative path resolves inside the configured root', async () => {
    const root = freshRoot();
    fs.writeFileSync(path.join(root, 'rel.txt'), 'hi');
    const real = await assertLocalPathAllowed('rel.txt', 'read');
    expect(real).toBe(path.join(root, 'rel.txt'));
  });

  it('an absolute path inside the root is allowed', async () => {
    const root = freshRoot();
    const inside = path.join(root, 'ok.txt');
    fs.writeFileSync(inside, 'hi');
    await expect(assertLocalPathAllowed(inside, 'read')).resolves.toBe(inside);
  });

  it('the default root (unset GOOGLE_LOCAL_FILES_DIR) is <home>/Downloads/mcp-google-multi', () => {
    delete process.env.GOOGLE_LOCAL_FILES_DIR;
    const fakeHome = () => '/fake/home';
    expect(localFilesRoot(process.env, fakeHome)).toBe(path.join('/fake/home', 'Downloads', 'mcp-google-multi'));
  });

  it('ensureLocalFilesRoot creates the default root (mode 0700) when it does not exist yet', async () => {
    const fakeHome = fs.mkdtempSync(path.join(TMP, 'mcp-gm-fakehome-'));
    created.push(fakeHome);
    delete process.env.GOOGLE_LOCAL_FILES_DIR;
    const root = ensureLocalFilesRoot(process.env, () => fakeHome);
    expect(root).toBe(path.join(fakeHome, 'Downloads', 'mcp-google-multi'));
    expect(fs.existsSync(root)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    }
  });

  it('a root wide enough to contain the config dir still refuses the config dir (defense in depth)', async () => {
    // configDir() is itself under os.tmpdir() in tests (tests/setup.ts); a
    // root at os.tmpdir() is deliberately "too wide" the way the review
    // describes ($HOME would have the same property in production.
    process.env.GOOGLE_LOCAL_FILES_DIR = TMP;
    const dir = configDir();
    fs.mkdirSync(dir, { recursive: true });
    const secret = path.join(dir, 'master.key');
    fs.writeFileSync(secret, 'SECRETKEY');
    await expect(assertLocalPathAllowed(secret, 'read')).rejects.toMatchObject({ reason: 'forbidden' });
  });

  // HIGH (item 1): drive_transfer's download-then-upload fallback reads its
  // own staging file (under os.tmpdir(), never a caller argument) back for
  // the upload. The rest of this suite pins GOOGLE_LOCAL_FILES_DIR to
  // os.tmpdir() (tests/setup.ts), so a regression here would pass silently
  // everywhere else; these two tests deliberately point the root somewhere
  // else so "outside the configured root" is real, the way it is in
  // production whenever an operator sets GOOGLE_LOCAL_FILES_DIR at all.
  it('openInternalReadStream (the server\'s own temp-file read) bypasses the root entirely and never creates it', async () => {
    const unusedRoot = path.join(TMP, `mcp-gm-unused-root-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    process.env.GOOGLE_LOCAL_FILES_DIR = unusedRoot;
    const outside = outsideDir();
    const tmp = path.join(outside, 'server-staged-file.bin');
    fs.writeFileSync(tmp, 'payload');
    // Before the fix this was openLocalReadStream(tmp): refused with
    // 'forbidden' (root != os.tmpdir()), and ensureLocalFilesRoot's
    // mkdirSync had already created unusedRoot as a side effect of the
    // containment check, even on the refused call.
    await expect(openInternalReadStream(tmp)).resolves.toBeDefined();
    expect(fs.existsSync(unusedRoot)).toBe(false);
  });

  it('contrast: the guarded openLocalReadStream still refuses a caller-supplied path outside that same root', async () => {
    const unusedRoot = path.join(TMP, `mcp-gm-unused-root-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    process.env.GOOGLE_LOCAL_FILES_DIR = unusedRoot;
    const outside = outsideDir();
    const tmp = path.join(outside, 'caller-supplied.bin');
    fs.writeFileSync(tmp, 'payload');
    await expect(openLocalReadStream(tmp)).rejects.toMatchObject({ reason: 'forbidden' });
  });
});
