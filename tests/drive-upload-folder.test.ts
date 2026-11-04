import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fakeServer, parseResult as parse, type GoogleRequest } from './_tool-harness.js';
import { buildRegistry } from '../src/compose.js';
import { buildIdentityContext } from '../src/identity.js';
import { planLocalFolder } from '../src/tools/drive.js';

// drive_upload with localDir: a whole local folder, tree kept, in one call.
const TMP = fs.realpathSync.native(os.tmpdir());

/** Fake Drive: folder creates (JSON body) and file uploads (multipart stream)
 * get sequential ids; `failName` makes uploads of that file name fail. */
function ownerHarness(opts: { failName?: string } = {}) {
  let n = 0;
  const created: Array<{ kind: 'folder' | 'file'; name: string; parent: string | undefined; id: string }> = [];
  const request = vi.fn(async (req: GoogleRequest) => {
    const isUpload = req.url.includes('/upload/');
    let name: string;
    let parents: string[] | undefined;
    let mimeType: string | undefined;
    if (isUpload) {
      const chunks = ((req.data as any)?._readableState?.buffer ?? []) as Buffer[];
      const meta = JSON.parse(/\{[^]*?\}(?=\r\n)/.exec(Buffer.concat(chunks).toString('utf8'))?.[0] ?? '{}');
      ({ name, parents } = meta);
    } else {
      ({ name, parents, mimeType } = req.data as { name: string; parents?: string[]; mimeType?: string });
    }
    if (isUpload && name === opts.failName) {
      throw Object.assign(new Error('Rate limit'), {
        code: 403,
        response: { status: 403, data: { error: { code: 403, message: 'Rate limit', errors: [{ reason: 'userRateLimitExceeded' }] } } },
      });
    }
    const id = `${isUpload ? 'F' : 'D'}${++n}`;
    created.push({ kind: mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file', name, parent: parents?.[0], id });
    return { data: { id, name, webViewLink: `https://drive.example.com/${id}` }, headers: new Headers(), status: 200 };
  });
  const ctx = buildIdentityContext({} as NodeJS.ProcessEnv) as any;
  ctx.getClient = async () => ({ request });
  ctx.policy = { profile: 'full-writes', readOnly: false, allow: [], deny: [] };
  const { server, handlers, schemas } = fakeServer();
  buildRegistry(server as never, ctx, 'eager');
  return { handlers, schemas, request, created };
}

describe('drive_upload localDir', () => {
  const dirs: string[] = [];
  const priorRoot = process.env.GOOGLE_LOCAL_FILES_DIR;
  afterEach(() => {
    if (priorRoot === undefined) delete process.env.GOOGLE_LOCAL_FILES_DIR;
    else process.env.GOOGLE_LOCAL_FILES_DIR = priorRoot;
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  /** A fresh local-files root holding `tree` (a path -> content map). */
  function root(tree: Record<string, string>): string {
    const r = fs.mkdtempSync(path.join(TMP, 'mcp-gm-folder-'));
    dirs.push(r);
    process.env.GOOGLE_LOCAL_FILES_DIR = r;
    for (const [rel, content] of Object.entries(tree)) {
      const full = path.join(r, ...rel.split('/'));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return r;
  }

  it('is declared on the owner context only', () => {
    root({});
    expect(ownerHarness().schemas.drive_upload).toHaveProperty('localDir');
  });

  it('recreates the folder tree and uploads every file under the right parent', async () => {
    root({ 'proj/a.txt': 'a', 'proj/sub/b.txt': 'b', 'proj/sub/deep/c.md': 'c' });
    const h = ownerHarness();
    const res = await h.handlers.drive_upload({ account: 'test', localDir: 'proj', parentFolderId: 'P0' });
    expect(res.isError).toBeFalsy();
    const out = parse(res);
    expect(out).toMatchObject({ uploaded: 3, failed: 0, skippedCount: 0 });
    expect(out.folder).toMatchObject({ name: 'proj' });

    const byName = Object.fromEntries(h.created.map((c) => [c.name, c]));
    expect(byName.proj).toMatchObject({ kind: 'folder', parent: 'P0' });
    expect(byName.sub).toMatchObject({ kind: 'folder', parent: byName.proj.id });
    expect(byName.deep).toMatchObject({ kind: 'folder', parent: byName.sub.id });
    expect(byName['a.txt'].parent).toBe(byName.proj.id);
    expect(byName['b.txt'].parent).toBe(byName.sub.id);
    expect(byName['c.md'].parent).toBe(byName.deep.id);
    expect(out.results.map((r: { path: string }) => r.path).sort()).toEqual(['a.txt', 'sub/b.txt', 'sub/deep/c.md']);
  });

  it('names the Drive folder from filename when given', async () => {
    root({ 'proj/a.txt': 'a' });
    const h = ownerHarness();
    const out = parse(await h.handlers.drive_upload({ account: 'test', localDir: 'proj', filename: 'Archive 2026' }));
    expect(out.folder.name).toBe('Archive 2026');
  });

  it('skips hidden entries and symlinks, and reports them', async () => {
    const r = root({ 'proj/a.txt': 'a', 'proj/.secret': 'x', 'proj/.hidden/d.txt': 'd' });
    const outside = path.join(r, 'outside.txt');
    fs.writeFileSync(outside, 'o');
    fs.symlinkSync(outside, path.join(r, 'proj', 'link.txt'));
    const h = ownerHarness();
    const out = parse(await h.handlers.drive_upload({ account: 'test', localDir: 'proj' }));
    expect(out.uploaded).toBe(1);
    expect(out.skippedCount).toBe(3);
    expect(out.skipped).toEqual(expect.arrayContaining([
      { path: '.secret', reason: 'hidden' },
      { path: '.hidden', reason: 'hidden' },
      { path: 'link.txt', reason: 'symlink' },
    ]));
  });

  it('one failing file does not stop the rest', async () => {
    root({ 'proj/ok1.txt': '1', 'proj/bad.txt': '2', 'proj/ok2.txt': '3' });
    const h = ownerHarness({ failName: 'bad.txt' });
    const res = await h.handlers.drive_upload({ account: 'test', localDir: 'proj' });
    expect(res.isError).toBeFalsy();
    const out = parse(res);
    expect(out).toMatchObject({ uploaded: 2, failed: 1 });
    expect(out.results.find((x: { path: string }) => x.path === 'bad.txt')).toMatchObject({ ok: false, error: 'rate_limited' });
  });

  it('is an error when every file failed, and the empty folder case is not', async () => {
    root({ 'only/bad.txt': '1', 'empty/.keep': '' });
    const h = ownerHarness({ failName: 'bad.txt' });
    expect((await h.handlers.drive_upload({ account: 'test', localDir: 'only' })).isError).toBe(true);
    const empty = await h.handlers.drive_upload({ account: 'test', localDir: 'empty' });
    expect(empty.isError).toBeFalsy();
    expect(parse(empty)).toMatchObject({ uploaded: 0, failed: 0 });
  });

  it('refuses a folder over the file cap before creating anything in Drive', async () => {
    const tree: Record<string, string> = {};
    for (let i = 0; i < 201; i++) tree[`big/f${i}.txt`] = 'x';
    root(tree);
    const h = ownerHarness();
    const res = await h.handlers.drive_upload({ account: 'test', localDir: 'big' });
    expect(res.isError).toBe(true);
    expect(parse(res).error).toBe('invalid_params');
    expect(h.request).not.toHaveBeenCalled();
  });

  it('refuses a path outside the local-files root, a plain file, and a missing folder', async () => {
    const r = root({ 'file.txt': 'x' });
    const outside = fs.mkdtempSync(path.join(TMP, 'mcp-gm-outside-'));
    dirs.push(outside);
    const h = ownerHarness();
    expect(parse(await h.handlers.drive_upload({ account: 'test', localDir: outside })).error).toBe('local_path_forbidden');
    expect(parse(await h.handlers.drive_upload({ account: 'test', localDir: path.join(r, 'file.txt') })).error).toBe('invalid_params');
    expect(parse(await h.handlers.drive_upload({ account: 'test', localDir: 'nope' })).error).toBe('invalid_params');
    expect(h.request).not.toHaveBeenCalled();
  });

  it('cannot be combined with the single-file inputs', async () => {
    root({ 'proj/a.txt': 'a' });
    const h = ownerHarness();
    for (const extra of [{ localPath: 'proj/a.txt' }, { contentBase64: 'YQ==' }, { convertTo: 'document' }, { mimeType: 'text/plain' }]) {
      const res = await h.handlers.drive_upload({ account: 'test', localDir: 'proj', ...extra });
      expect(parse(res).error).toBe('invalid_params');
    }
    expect(h.request).not.toHaveBeenCalled();
  });

  it('is refused for a caller that may not read host files, like localPath', async () => {
    root({ 'proj/a.txt': 'a' });
    const priorSwitch = process.env.GOOGLE_LOCAL_FILES;
    process.env.GOOGLE_LOCAL_FILES = 'off';
    try {
      const h = ownerHarness();
      expect(h.schemas.drive_upload).not.toHaveProperty('localDir');
      const res = await h.handlers.drive_upload({ account: 'test', localDir: 'proj' });
      expect(parse(res)).toMatchObject({ error: 'forbidden' });
      expect(h.request).not.toHaveBeenCalled();
    } finally {
      if (priorSwitch === undefined) delete process.env.GOOGLE_LOCAL_FILES;
      else process.env.GOOGLE_LOCAL_FILES = priorSwitch;
    }
  });
});

describe('planLocalFolder', () => {
  it('lists parents before children, sorted, with posix paths', async () => {
    const r = fs.mkdtempSync(path.join(TMP, 'mcp-gm-plan-'));
    try {
      fs.mkdirSync(path.join(r, 'b', 'c'), { recursive: true });
      fs.mkdirSync(path.join(r, 'a'));
      fs.writeFileSync(path.join(r, 'z.txt'), '');
      fs.writeFileSync(path.join(r, 'b', 'c', 'd.txt'), '');
      const plan = await planLocalFolder(r);
      expect(plan?.dirs).toEqual(['a', 'b', 'b/c']);
      expect(plan?.files).toEqual(['b/c/d.txt', 'z.txt']);
    } finally {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });
});
