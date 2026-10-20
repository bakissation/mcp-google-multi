import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { readAttachments } from '../src/tools/gmail.js';
import { configDir } from '../src/config-file.js';

let base: string;
beforeEach(() => { base = mkdtempSync(path.join(tmpdir(), 'attach-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

describe('readAttachments security guards', () => {
  // GOOGLE_LOCAL_FILES_DIR confines every host-file path to a root; a
  // relative path now resolves inside that root (tests/setup.ts pins it to
  // os.tmpdir()) rather than being rejected outright for not being absolute.
  it('a relative path resolves inside the configured local-files root', async () => {
    const name = `attach-rel-${Date.now()}.txt`;
    const abs = path.join(tmpdir(), name);
    writeFileSync(abs, 'hi');
    try {
      const out = await readAttachments([{ path: name }], 0);
      expect(out![0].content.toString()).toBe('hi');
    } finally {
      rmSync(abs, { force: true });
    }
  });

  it('a relative path that does not exist under the root is reported not found, not a security refusal', async () => {
    await expect(readAttachments([{ path: 'rel/file-does-not-exist.txt' }], 0)).rejects.toThrow(/not found|unreadable/i);
  });

  it('a file inside the config/token dir is refused (secret-exfil guard)', async () => {
    // configDir() resolves to the test-sandboxed XDG dir (tests/setup.ts).
    const dir = configDir();
    mkdirSync(dir, { recursive: true });
    const secret = path.join(dir, 'master.key');
    writeFileSync(secret, 'SECRETKEY');
    await expect(readAttachments([{ path: secret }], 0)).rejects.toThrow(/config\/token directory|forbidden|E_ATTACHMENT_FORBIDDEN/i);
  });

  it.skipIf(process.platform === 'win32')('a symlink pointing into the config dir is also refused (realpath before check)', async () => {
    const dir = configDir();
    mkdirSync(dir, { recursive: true });
    const secret = path.join(dir, 'tokenlink-target.key');
    writeFileSync(secret, 'SECRET');
    const link = path.join(base, 'innocent.txt');
    symlinkSync(secret, link);
    await expect(readAttachments([{ path: link }], 0)).rejects.toThrow(/config\/token directory|forbidden|E_ATTACHMENT_FORBIDDEN/i);
  });

  it.skipIf(process.platform === 'win32')('a non-regular file (FIFO) is rejected, never read (no hang)', async () => {
    const fifo = path.join(base, 'pipe');
    execSync(`mkfifo ${fifo}`);
    await expect(readAttachments([{ path: fifo }], 0)).rejects.toThrow(/not a regular file/);
  });

  it('an over-cap file is rejected by stat before reading (encoded estimate)', async () => {
    const big = path.join(base, 'big.bin');
    // 20 MB raw → ~27 MB encoded → over the 25 MB Gmail limit
    writeFileSync(big, Buffer.alloc(20 * 1024 * 1024));
    await expect(readAttachments([{ path: big }], 0)).rejects.toThrow(/E_ATTACHMENT_TOO_LARGE|message limit/);
  });

  it('a normal small file is read with basename filename + content-type', async () => {
    const p = path.join(base, 'report.pdf');
    writeFileSync(p, '%PDF-1.4 hi');
    const out = await readAttachments([{ path: p }], 0);
    expect(out).toHaveLength(1);
    expect(out![0].filename).toBe('report.pdf');
    expect(out![0].contentType).toBe('application/pdf');
    expect(out![0].content.toString()).toBe('%PDF-1.4 hi');
  });

  it('a caller filename with path separators is reduced to basename', async () => {
    const p = path.join(base, 'ok.txt');
    writeFileSync(p, 'x');
    const out = await readAttachments([{ path: p, filename: '../../etc/passwd' }], 0);
    expect(out![0].filename).toBe('passwd');
  });
});
