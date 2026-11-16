import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { fakeServer, parseResult, type GoogleRequest } from './_tool-harness.js';
import { buildRegistry } from '../src/compose.js';
import { buildIdentityContext } from '../src/identity.js';
import { normalizeCallArguments, type ArgShape } from '../src/arg-normalize.js';
import { prepareLocalDest } from '../src/tools/_local-files.js';
import { isRetriableNetworkError } from '../src/tools/_errors.js';
import { OAuth2Client } from 'googleapis-common';
import { makeGetClient } from '../src/client.js';

function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'mcp-gm-paths-'));
  const prior = process.env.GOOGLE_LOCAL_FILES_DIR;
  process.env.GOOGLE_LOCAL_FILES_DIR = root;
  return fn(root).finally(() => {
    if (prior === undefined) delete process.env.GOOGLE_LOCAL_FILES_DIR;
    else process.env.GOOGLE_LOCAL_FILES_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  });
}

describe('prepareLocalDest', () => {
  it('uses the root when savePath is omitted', () =>
    withRoot(async (root) => {
      const dest = await prepareLocalDest(undefined, 'a.pdf', { nameGiven: false });
      expect(dest).toBe(path.join(root, 'a.pdf'));
    }));

  it('treats a savePath with an extension as the file when no name is given', () =>
    withRoot(async (root) => {
      const dest = await prepareLocalDest('out/report.pdf', 'drive-name.pdf', { nameGiven: false });
      expect(dest).toBe(path.join(root, 'out', 'report.pdf'));
    }));

  it('keeps a savePath as a folder when a filename is given', () =>
    withRoot(async (root) => {
      const dest = await prepareLocalDest('out/report.pdf', 'chosen.pdf', { nameGiven: true });
      expect(dest).toBe(path.join(root, 'out', 'report.pdf', 'chosen.pdf'));
    }));

  it('keeps an existing folder with a dotted name as a folder', () =>
    withRoot(async (root) => {
      fs.mkdirSync(path.join(root, 'v1.2'));
      const dest = await prepareLocalDest('v1.2', 'a.pdf', { nameGiven: false });
      expect(dest).toBe(path.join(root, 'v1.2', 'a.pdf'));
    }));
});

describe('tool descriptions and optional savePath', () => {
  function ownerRegistry(respond: (req: GoogleRequest) => unknown) {
    const request = vi.fn(async (req: GoogleRequest) => ({ data: await respond(req), headers: new Headers(), status: 200 }));
    const ctx = buildIdentityContext({} as NodeJS.ProcessEnv) as any;
    ctx.getClient = async () => ({ request });
    ctx.policy = { profile: 'full-writes', readOnly: false, allow: [], deny: [] };
    const fake = fakeServer();
    buildRegistry(fake.server as never, ctx, 'eager');
    return { ...fake, request };
  }

  it('declares savePath optional and names the allowed root', () =>
    withRoot(async (root) => {
      const h = ownerRegistry(() => ({}));
      for (const tool of ['drive_download', 'drive_export', 'gmail_download_attachment']) {
        const shape = h.schemas[tool] as Record<string, any>;
        expect(shape.savePath.isOptional()).toBe(true);
        expect(shape.savePath.description).toContain(root);
      }
    }));

  it('drive_download without savePath writes into the root', () =>
    withRoot(async (root) => {
      const h = ownerRegistry((req) => {
        if ((req as any).responseType === 'stream') return Readable.from(['bytes']);
        return { id: 'f1', name: 'doc.bin', mimeType: 'application/octet-stream' };
      });
      const res = await h.handlers.drive_download({ account: 'test', fileId: 'f1' });
      expect(res.isError).toBeFalsy();
      expect(parseResult(res).savedPath).toBe(path.join(root, 'doc.bin'));
      expect(fs.readFileSync(path.join(root, 'doc.bin'), 'utf8')).toBe('bytes');
    }));

  it('drive_download takes a file path in savePath as the destination file', () =>
    withRoot(async (root) => {
      const h = ownerRegistry((req) => {
        if ((req as any).responseType === 'stream') return Readable.from(['bytes']);
        return { id: 'f1', name: 'doc.bin', mimeType: 'application/octet-stream' };
      });
      const res = await h.handlers.drive_download({ account: 'test', fileId: 'f1', savePath: 'out/mine.bin' });
      expect(parseResult(res).savedPath).toBe(path.join(root, 'out', 'mine.bin'));
    }));
});

describe('repeated single-file uploads', () => {
  it('suggests localDir after several files from one folder', () =>
    withRoot(async (root) => {
      const request = vi.fn(async () => ({ data: { id: 'u1', name: 'x' }, headers: new Headers(), status: 200 }));
      const ctx = buildIdentityContext({} as NodeJS.ProcessEnv) as any;
      ctx.getClient = async () => ({ request });
      ctx.policy = { profile: 'full-writes', readOnly: false, allow: [], deny: [] };
      const fake = fakeServer();
      buildRegistry(fake.server as never, ctx, 'eager');
      const hints: unknown[] = [];
      for (let i = 0; i < 6; i++) {
        fs.writeFileSync(path.join(root, `f${i}.txt`), 'x');
        const res = await fake.handlers.drive_upload({ account: 'test', localPath: `f${i}.txt` });
        hints.push(parseResult(res).hint);
      }
      expect(hints[0]).toBeUndefined();
      expect(String(hints[hints.length - 1])).toContain('localDir');
    }));
});

describe('silent path aliases', () => {
  const download: ArgShape = new Map([['account', 'other'], ['fileId', 'other'], ['savePath', 'other']] as const);
  const upload: ArgShape = new Map([['account', 'other'], ['localPath', 'other'], ['localDir', 'other']] as const);

  it('maps a path-like key to savePath on a download tool', () => {
    const { args, renamed } = normalizeCallArguments(download, { account: 'a', fileId: 'f', file_path: '/tmp/x.pdf' }, 'drive_download');
    expect(args).toEqual({ account: 'a', fileId: 'f', savePath: '/tmp/x.pdf' });
    expect(renamed).toEqual([['file_path', 'savePath']]);
  });

  it('maps path to localPath on drive_upload and directory to localDir', () => {
    expect(normalizeCallArguments(upload, { path: 'a.txt' }, 'drive_upload').args).toEqual({ localPath: 'a.txt' });
    expect(normalizeCallArguments(upload, { directory: 'photos' }, 'drive_upload').args).toEqual({ localDir: 'photos' });
  });

  it('does not map file anywhere, nor path on drive_update (a rename must not become a content swap)', () => {
    const update: ArgShape = new Map([['account', 'other'], ['fileId', 'other'], ['localPath', 'other']] as const);
    const a = { fileId: 'f', path: 'report.pdf' };
    expect(normalizeCallArguments(update, a, 'drive_update').args).toBe(a);
    const b = { fileId: 'f', file: 'report.pdf' };
    expect(normalizeCallArguments(update, b, 'drive_update').args).toBe(b);
    expect(normalizeCallArguments(upload, { file: 'a.txt' }, 'drive_upload').renamed).toEqual([]);
    expect(normalizeCallArguments(update, { fileId: 'f', filePath: 'a.txt' }, 'drive_update').args).toEqual({ fileId: 'f', localPath: 'a.txt' });
  });

  it('never overrides a declared key that is already present', () => {
    const input = { fileId: 'f', savePath: 'real', path: 'other' };
    const { args, renamed } = normalizeCallArguments(download, input, 'drive_download');
    expect(args).toBe(input);
    expect(renamed).toEqual([]);
  });

  it('leaves other tools and absent targets alone', () => {
    const input = { path: 'x' };
    expect(normalizeCallArguments(download, input, 'drive_copy').args).toBe(input);
    expect(normalizeCallArguments(new Map([['account', 'other']]) as ArgShape, input, 'drive_download').args).toBe(input);
    expect(normalizeCallArguments(download, input).args).toBe(input);
  });
});

describe('token refresh retry', () => {
  const deps = () => ({
    accounts: () =>
      ({
        aliases: ['work'],
        configs: { work: { email: 'w@x.example', tokenPath: '/x', encPath: '/x', source: 'env' } },
        scopeProfiles: { base: { bundles: [] } },
        source: 'env',
        stamp: 'env:0',
      }) as never,
    readToken: () => ({ refresh_token: 'rt' }) as never,
    updateToken: () => undefined,
  });

  async function refreshWith(failures: unknown[]) {
    process.env.GOOGLE_CLIENT_ID = 'id';
    process.env.GOOGLE_CLIENT_SECRET = 'secret';
    const proto = OAuth2Client.prototype as any;
    const spy = vi.spyOn(proto, 'refreshTokenNoCache');
    for (const f of failures) spy.mockRejectedValueOnce(f);
    spy.mockResolvedValue({ tokens: { access_token: 'a' } });
    try {
      const client = (await makeGetClient('retry-test', deps())('work')) as any;
      const out = await client.refreshTokenNoCache('rt').catch((e: unknown) => e);
      return { out, calls: spy.mock.calls.length };
    } finally {
      spy.mockRestore();
    }
  }

  it('retries a token fetch once after a timeout', async () => {
    const { out, calls } = await refreshWith([Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })]);
    expect(out).toEqual({ tokens: { access_token: 'a' } });
    expect(calls).toBe(2);
  });

  it('retries only once', async () => {
    const t = () => Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    const { out, calls } = await refreshWith([t(), t(), t()]);
    expect(out).toBeInstanceOf(Error);
    expect(calls).toBe(2);
  });

  it('does not retry an invalid_grant answer', async () => {
    const { out, calls } = await refreshWith([Object.assign(new Error('invalid_grant'), { code: 400 })]);
    expect(out).toBeInstanceOf(Error);
    expect(calls).toBe(1);
  });

  it('classifies connect and timeout codes as retriable, not ENOTFOUND or a Google 4xx', () => {
    expect(isRetriableNetworkError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe(true);
    expect(isRetriableNetworkError({ cause: { code: 'ECONNRESET' } })).toBe(true);
    expect(isRetriableNetworkError(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe(false);
    expect(isRetriableNetworkError(Object.assign(new Error('invalid_grant'), { code: 400 }))).toBe(false);
  });
});
