import { describe, it, expect, afterEach, vi } from 'vitest';
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
import { loadEnvFiles } from '../src/env-load.js';

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

  // GOOGLE_LOCAL_FILES_DIR confines paths to a root; a relative path now
  // resolves inside that root (pinned to os.tmpdir() for tests) rather than
  // being rejected for not being absolute.
  it('a relative path resolves inside the configured root, not process.cwd()', async () => {
    const dir = tmpDir();
    const name = path.basename(dir) + path.sep + 'payload.txt';
    fs.writeFileSync(path.join(dir, 'payload.txt'), 'hello relative');
    const stream = await openLocalReadStream(name);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hello relative');
  });

  it('a relative path to a missing file still rejects with ENOENT, not a security refusal', async () => {
    await expect(openLocalReadStream('relative/does-not-exist.txt')).rejects.toMatchObject({ code: 'ENOENT' });
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

  it('a relative path resolves inside the configured root for both read and write', async () => {
    const dir = tmpDir();
    const leaf = path.basename(dir);
    fs.writeFileSync(path.join(dir, 'exists.txt'), 'x');
    await expect(assertLocalPathAllowed(`${leaf}/exists.txt`, 'read')).resolves.toBe(path.join(dir, 'exists.txt'));
    await expect(assertLocalPathAllowed(`${leaf}/new-file.txt`, 'write')).resolves.toBe(path.join(dir, 'new-file.txt'));
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

// M4: same off|0|false|no / on|1|true|yes switch parsing as GOOGLE_USAGE_METRICS,
// case-insensitive, with a stderr warning (not a silent fallback) on an
// unrecognised non-empty value.
describe('localFilesDisabledByEnv (GOOGLE_LOCAL_FILES switch parsing)', () => {
  it('unset or empty leaves host files enabled', () => {
    expect(localFilesDisabledByEnv({})).toBe(false);
    expect(localFilesDisabledByEnv({ GOOGLE_LOCAL_FILES: '' })).toBe(false);
    expect(localFilesDisabledByEnv({ GOOGLE_LOCAL_FILES: '  ' })).toBe(false);
  });

  it('every off-synonym disables, case-insensitively', () => {
    for (const v of ['off', 'Off', 'OFF', '0', 'false', 'FALSE', 'no', 'No']) {
      expect(localFilesDisabledByEnv({ GOOGLE_LOCAL_FILES: v }), v).toBe(true);
    }
  });

  it('every on-synonym explicitly re-enables, case-insensitively', () => {
    for (const v of ['on', 'On', '1', 'true', 'TRUE', 'yes', 'Yes']) {
      expect(localFilesDisabledByEnv({ GOOGLE_LOCAL_FILES: v }), v).toBe(false);
    }
  });

  it('an unrecognised value warns to stderr and leaves host files enabled (the default)', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(localFilesDisabledByEnv({ GOOGLE_LOCAL_FILES: 'maybe' })).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toContain('GOOGLE_LOCAL_FILES="maybe"');
    } finally {
      spy.mockRestore();
    }
  });
});

// M3: the guard also refuses /proc (/proc/self/environ holds the same
// secrets a .env file does, on any Linux host), the .env files this server
// actually loaded a secret from (wherever they live, not just the config
// dir), and DISCOVERY_CACHE_PATH (an operator can point it anywhere).
describe('assertLocalPathAllowed: additional denied sources (M3)', () => {
  it.skipIf(process.platform !== 'linux')('refuses a read of /proc/self/environ', async () => {
    await expect(openLocalReadStream('/proc/self/environ')).rejects.toMatchObject({ reason: 'forbidden' });
  });

  it.skipIf(process.platform !== 'linux')('refuses any path under /proc, not just environ', async () => {
    // /proc/self/status is a real file under /proc, unlike /proc/self/cwd
    // (a symlink that realpath legitimately resolves to a normal directory
    // elsewhere, so it is not itself a sensitive /proc path once resolved).
    await expect(assertLocalPathAllowed('/proc/self/status', 'read')).rejects.toMatchObject({ reason: 'forbidden' });
  });

  it('refuses a read inside DISCOVERY_CACHE_PATH, wherever an operator points it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gm-disco-'));
    const prior = process.env.DISCOVERY_CACHE_PATH;
    process.env.DISCOVERY_CACHE_PATH = dir;
    try {
      const cached = path.join(dir, 'drive-v3.json');
      fs.writeFileSync(cached, '{}');
      await expect(openLocalReadStream(cached)).rejects.toMatchObject({ reason: 'forbidden' });
    } finally {
      if (prior === undefined) delete process.env.DISCOVERY_CACHE_PATH;
      else process.env.DISCOVERY_CACHE_PATH = prior;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a .env file this server actually loaded a secret from', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gm-envfile-'));
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, 'MCP_GM_TEST_PROBE_VAR=abc\n');
    try {
      // Test-only path overrides (see env-load.ts): loads ONLY from `dir`,
      // under a variable name picked to be inert outside this test.
      loadEnvFiles({ cwd: dir, packageRoot: dir, configDir: dir });
      await expect(openLocalReadStream(envFile)).rejects.toMatchObject({ reason: 'forbidden' });
    } finally {
      delete process.env.MCP_GM_TEST_PROBE_VAR;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not refuse an ordinary .env-named file the server never loaded', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gm-envfile-other-'));
    const other = path.join(dir, '.env');
    fs.writeFileSync(other, 'UNRELATED=1\n');
    try {
      const real = await assertLocalPathAllowed(other, 'read');
      expect(real).toBe(path.resolve(other));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
