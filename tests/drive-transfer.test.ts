import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { transferExportPlan } from '../src/tools/drive.js';
import { toolHarness, accountSet, type GoogleRequest } from './_tool-harness.js';

describe('transferExportPlan', () => {
  it.each([
    ['application/pdf', { kind: 'binary' }],
    ['image/png', { kind: 'binary' }],
    [null, { kind: 'binary' }],
    [undefined, { kind: 'binary' }],
    [
      'application/vnd.google-apps.document',
      {
        kind: 'native',
        exportMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        convertTo: 'application/vnd.google-apps.document',
      },
    ],
    [
      'application/vnd.google-apps.spreadsheet',
      {
        kind: 'native',
        exportMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        convertTo: 'application/vnd.google-apps.spreadsheet',
      },
    ],
    [
      'application/vnd.google-apps.presentation',
      {
        kind: 'native',
        exportMime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        convertTo: 'application/vnd.google-apps.presentation',
      },
    ],
    ['application/vnd.google-apps.drawing', { kind: 'native', exportMime: 'image/png' }],
    ['application/vnd.google-apps.form', { kind: 'unsupported' }],
    ['application/vnd.google-apps.site', { kind: 'unsupported' }],
    ['application/vnd.google-apps.folder', { kind: 'unsupported' }],
  ])('%s → %j', (mimeType, expected) => {
    expect(transferExportPlan(mimeType as string | null | undefined)).toEqual(expected);
  });
});

// HIGH (item 1), through the real tool handler: drive_transfer's
// download-then-upload fallback stages the download under os.tmpdir()
// (its own internal plumbing, never a caller argument) and reads it back
// for the upload. tests/setup.ts pins GOOGLE_LOCAL_FILES_DIR to
// os.tmpdir() for the rest of the suite, which would make this pass even
// if the read went through the GUARDED path (tmp is trivially "inside"
// the root when the root IS tmpdir); pointing the root somewhere else
// here is what actually exercises the guard bypass.
describe('drive_transfer: the download-then-upload fallback reads its staging file through the real handler', () => {
  const priorRoot = process.env.GOOGLE_LOCAL_FILES_DIR;
  const created: string[] = [];
  afterEach(() => {
    if (priorRoot === undefined) delete process.env.GOOGLE_LOCAL_FILES_DIR;
    else process.env.GOOGLE_LOCAL_FILES_DIR = priorRoot;
    for (const p of created.splice(0)) fs.rmSync(p, { recursive: true, force: true });
  });

  it('falls back to download+upload and succeeds even when GOOGLE_LOCAL_FILES_DIR is not os.tmpdir()', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gm-transfer-root-'));
    created.push(root);
    process.env.GOOGLE_LOCAL_FILES_DIR = root;

    const accounts = accountSet({ src: { email: 'src@example.com' }, dst: { email: 'dst@example.com' } });
    const h = toolHarness({
      accounts,
      requestImpl: async (req: GoogleRequest & { responseType?: string }) => {
        const method = (req.method ?? 'GET').toUpperCase();
        const url = req.url;
        if (method === 'GET' && /\/files\/f1(\?|$)/.test(url) && req.responseType !== 'stream') {
          return { data: { id: 'f1', name: 'report.pdf', mimeType: 'application/pdf', size: '13' }, headers: new Headers() };
        }
        if (method === 'POST' && /\/files\/f1\/permissions/.test(url)) {
          // share+copy is blocked (e.g. cross-domain sharing disabled):
          // falls through to the download+upload fallback.
          throw new Error('Sharing is not supported for this item');
        }
        if (method === 'GET' && req.responseType === 'stream') {
          return { data: Readable.from(Buffer.from('file contents')), headers: new Headers() };
        }
        if (method === 'POST' && /\/files(\?|$)/.test(url)) {
          return { data: { id: 'copy1', name: 'report.pdf', mimeType: 'application/pdf' }, headers: new Headers() };
        }
        return { data: {}, headers: new Headers() };
      },
    });
    const res = await h.call('drive_transfer', { fromAccount: 'src', toAccount: 'dst', fileId: 'f1' });
    expect(res.isError).toBeFalsy();
    const requests = h.requests();
    expect(requests.some((r) => /\/files\/f1\/permissions/.test(r.url))).toBe(true); // share+copy was tried
    expect(requests.some((r) => (r.method ?? 'GET').toUpperCase() === 'POST' && /\/files(\?|$)/.test(r.url))).toBe(true); // upload happened
  });
});
