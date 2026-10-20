import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cleanupPartialWrite } from '../src/tools/_local-files.js';

// LOW (item 6): drive_download/drive_export/gmail_download_attachment each
// unconditionally unlinked their destination after a failed write. wx
// (exclusive create) already refuses to clobber a file that exists at open
// time, but prepareLocalDest's own existence check and that real open are
// not atomic together: a concurrent call for the SAME destination can win
// the race in between, and this call's own write then never starts (its
// open fails with EEXIST). The file left on disk at that path belongs
// entirely to whichever call did open it, never to the one that lost the
// race, so cleanup must not delete it. All three tools share one helper
// (cleanupPartialWrite) for this now, so one direct test of it covers all three.
describe('cleanupPartialWrite (item 6)', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const p of created.splice(0)) fs.rmSync(p, { recursive: true, force: true });
  });

  function freshFile(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gm-partial-'));
    created.push(dir);
    const file = path.join(dir, 'target.bin');
    fs.writeFileSync(file, contents);
    return file;
  }

  it('an EEXIST error leaves the file untouched: it belongs to whoever actually won the race', async () => {
    const file = freshFile('belongs-to-another-call');
    const eexist = Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
    await cleanupPartialWrite(file, eexist);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('belongs-to-another-call');
  });

  it('a non-EEXIST error (this call\'s own write started, then failed) still deletes the partial file', async () => {
    const file = freshFile('this-calls-own-partial-data');
    const networkError = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    await cleanupPartialWrite(file, networkError);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('an error with no .code at all (not an fs errno) is treated the same as "this call\'s own failure": still cleaned up', async () => {
    const file = freshFile('this-calls-own-partial-data');
    await cleanupPartialWrite(file, new Error('plain error with no code'));
    expect(fs.existsSync(file)).toBe(false);
  });

  it('never throws even if the unlink itself fails (e.g. the path is already gone)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gm-partial-'));
    created.push(dir);
    const neverExisted = path.join(dir, 'ghost.bin');
    await expect(cleanupPartialWrite(neverExisted, new Error('whatever'))).resolves.toBeUndefined();
  });
});
