import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { vi } from 'vitest';
import { fakeServer, parseResult as parse, type GoogleRequest } from './_tool-harness.js';
import { buildRegistry } from '../src/compose.js';
import { buildIdentityContext } from '../src/identity.js';

// Host-file tools on the owner context. `filename` is optional when a
// local file or the attachment itself names the result, and local-path
// refusals say how to fix the path instead of just refusing.
const TMP = fs.realpathSync.native(os.tmpdir());

function ownerHarness(respond: (req: GoogleRequest) => unknown) {
  const request = vi.fn(async (req: GoogleRequest) => ({ data: respond(req), headers: new Headers(), status: 200 }));
  const ctx = buildIdentityContext({} as NodeJS.ProcessEnv) as any;
  ctx.getClient = async () => ({ request });
  ctx.policy = { profile: 'full-writes', readOnly: false, allow: [], deny: [] };
  const { server, handlers } = fakeServer();
  buildRegistry(server as never, ctx, 'eager');
  return { handlers, request, requests: () => request.mock.calls.map(([r]) => r as GoogleRequest) };
}

describe('host-file tools: optional filename and actionable refusals', () => {
  const created: string[] = [];
  const priorRoot = process.env.GOOGLE_LOCAL_FILES_DIR;
  afterEach(() => {
    if (priorRoot === undefined) delete process.env.GOOGLE_LOCAL_FILES_DIR;
    else process.env.GOOGLE_LOCAL_FILES_DIR = priorRoot;
    for (const p of created.splice(0)) fs.rmSync(p, { recursive: true, force: true });
  });
  const dir = (prefix: string): string => {
    const d = fs.mkdtempSync(path.join(TMP, prefix));
    created.push(d);
    return d;
  };

  it('drive_upload from localPath defaults the Drive name to the file name', async () => {
    const root = dir('mcp-gm-flow-');
    process.env.GOOGLE_LOCAL_FILES_DIR = root;
    fs.writeFileSync(path.join(root, 'report.txt'), 'hello');
    const h = ownerHarness(() => ({ id: 'F1', name: 'report.txt' }));
    const res = await h.handlers.drive_upload({ account: 'test', localPath: 'report.txt' });
    expect(res.isError).toBeFalsy();
    const upload = h.requests().find((r) => r.url.includes('/upload/drive/v3/files') || r.url.includes('/drive/v3/files'));
    // The multipart stream is buffered in memory: its first part is the JSON metadata.
    const chunks = ((upload?.data as any)?._readableState?.buffer ?? []) as Buffer[];
    expect(Buffer.concat(chunks).toString('utf8')).toContain('"name":"report.txt"');
  });

  it('drive_upload with contentBase64 still needs a filename', async () => {
    const h = ownerHarness(() => ({}));
    const res = await h.handlers.drive_upload({ account: 'test', contentBase64: Buffer.from('x').toString('base64') });
    expect(res.isError).toBe(true);
    expect(parse(res).error).toBe('invalid_params');
    expect(h.requests()).toHaveLength(0);
  });

  it('a path outside the root is refused with the full requested path and a remedy', async () => {
    const root = dir('mcp-gm-flow-');
    const outside = dir('mcp-gm-outside-');
    process.env.GOOGLE_LOCAL_FILES_DIR = root;
    const target = path.join(outside, 'x.txt');
    fs.writeFileSync(target, 'x');
    const h = ownerHarness(() => ({}));
    const res = await h.handlers.drive_upload({ account: 'test', localPath: target });
    const env = parse(res);
    expect(env.error).toBe('local_path_forbidden');
    expect(env.message).toContain(target);
    expect(env.hint).toContain(root);
    expect(env.hint).toContain('GOOGLE_LOCAL_FILES_DIR');
  });

  it('a missing file reports the resolved path and where relative paths resolve', async () => {
    const root = dir('mcp-gm-flow-');
    process.env.GOOGLE_LOCAL_FILES_DIR = root;
    const h = ownerHarness(() => ({}));
    const res = await h.handlers.drive_upload({ account: 'test', localPath: 'nope.txt' });
    const env = parse(res);
    expect(env.error).toBe('invalid_params');
    expect(env.message).toContain(path.join(root, 'nope.txt'));
    expect(env.hint).toContain('GOOGLE_LOCAL_FILES_DIR');
  });

  it('gmail_download_attachment without filename saves under the attachment\'s own name', async () => {
    const root = dir('mcp-gm-flow-');
    process.env.GOOGLE_LOCAL_FILES_DIR = root;
    const h = ownerHarness((req) => {
      if (req.url.includes('/attachments/')) return { data: Buffer.from('pdf-bytes').toString('base64url'), size: 9 };
      return {
        id: 'M1',
        payload: { parts: [{ filename: '', body: {} }, { filename: 'invoice.pdf', body: { attachmentId: 'ATT1' } }] },
      };
    });
    const res = await h.handlers.gmail_download_attachment({ account: 'test', messageId: 'M1', attachmentId: 'ATT1', savePath: 'in' });
    expect(res.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(root, 'in', 'invoice.pdf'), 'utf8')).toBe('pdf-bytes');
  });

  it('gmail_download_attachment falls back to a generated name when the lookup finds nothing', async () => {
    const root = dir('mcp-gm-flow-');
    process.env.GOOGLE_LOCAL_FILES_DIR = root;
    const h = ownerHarness((req) => {
      if (req.url.includes('/attachments/')) return { data: Buffer.from('b').toString('base64url') };
      return { id: 'M1', payload: { parts: [] } };
    });
    const res = await h.handlers.gmail_download_attachment({ account: 'test', messageId: 'M1', attachmentId: 'ABCDEFGHIJ', savePath: 'in' });
    expect(res.isError).toBeFalsy();
    expect(fs.existsSync(path.join(root, 'in', 'attachment-ABCDEFGH'))).toBe(true);
  });
});
