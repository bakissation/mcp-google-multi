import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openLocalReadStream } from '../src/tools/_local-files.js';

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
});
