import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { toolHarness, fakeServer, parseResult, type GoogleRequest } from './_tool-harness.js';
import { buildRegistry } from '../src/compose.js';
import { buildIdentityContext } from '../src/identity.js';
import { mapGoogleError } from '../src/tools/_errors.js';
import { parseMessage } from '../src/tools/gmail.js';

const googleError = (code: number, message: string) => Object.assign(new Error(message), { code });

describe('gmail_read: a part without a filename', () => {
  it('lists no attachment and does not throw', () => {
    const msg = {
      id: 'm1',
      threadId: 't1',
      payload: {
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', body: { data: Buffer.from('hello').toString('base64url') } },
          { mimeType: 'application/octet-stream', body: { attachmentId: 'A1', size: 10 } },
          { mimeType: 'text/html', filename: undefined, body: {} },
        ],
      },
    };
    const out = parseMessage(msg);
    expect(out.body).toBe('hello');
    expect(Array.isArray(out.attachments)).toBe(true);
  });
});

describe('attachment token errors', () => {
  it('a 400 "Invalid attachment token" tells the caller to re-read the message', () => {
    const e = mapGoogleError(googleError(400, 'Invalid attachment token'), 'work');
    expect(e.error).toBe('bad_request');
    expect(e.hint).toContain('gmail_read');
    expect(e.hint).toContain('fresh');
  });
});

describe('drive_read: Sheets and Forms', () => {
  it('a Sheet whose text export is refused gets a hint to the sheets tools', async () => {
    const h = toolHarness({
      respond: (req: GoogleRequest) => {
        if (req.url.includes('/export')) throw googleError(400, 'Export only supports Docs Editors files.');
        return { id: 's1', name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet', webViewLink: 'https://x.example/s1' };
      },
    });
    const res = await h.call('drive_read', { account: 'test', fileId: 's1' });
    expect(res.isError).toBe(true);
    const out = parseResult(res);
    expect(out.error).toBe('unsupported_type');
    expect(out.hint).toContain('sheets_read_range');
  });

  it('a 403 rate limit on a Sheet export is not reported as an unsupported type', async () => {
    const h = toolHarness({
      respond: (req: GoogleRequest) => {
        if (req.url.includes('/export')) {
          throw Object.assign(new Error('Rate Limit Exceeded'), { code: 403, errors: [{ reason: 'rateLimitExceeded' }] });
        }
        return { id: 's1', name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet', webViewLink: 'https://x.example/s1' };
      },
    });
    const res = await h.call('drive_read', { account: 'test', fileId: 's1' });
    expect(res.isError).toBe(true);
    expect(parseResult(res).error).not.toBe('unsupported_type');
  });

  it('a Form points to forms_get instead of the download tools', async () => {
    const h = toolHarness({
      respond: () => ({ id: 'f1', name: 'Survey', mimeType: 'application/vnd.google-apps.form', webViewLink: 'https://x.example/f1' }),
    });
    const res = await h.call('drive_read', { account: 'test', fileId: 'f1' });
    const out = parseResult(res);
    expect(out.error).toBe('binary');
    expect(out.hint).toContain('forms_get');
    expect(out.hint).not.toContain('drive_download');
  });
});

describe('gmail_create_draft validation errors', () => {
  it('carry a hint', async () => {
    const h = toolHarness({ respond: () => ({}) });
    const res = await h.call('gmail_create_draft', { account: 'test', body: 'hi' });
    expect(res.isError).toBe(true);
    const out = parseResult(res);
    expect(out.error).toBe('validation_error');
    expect(typeof out.hint).toBe('string');
    expect(out.hint.length).toBeGreaterThan(10);
  });
});

describe('gmail_download_attachment limits', () => {
  function ownerHarness(respond: (req: GoogleRequest) => unknown | Promise<unknown>) {
    const request = vi.fn(async (req: GoogleRequest) => ({ data: await respond(req), headers: new Headers(), status: 200 }));
    const ctx = buildIdentityContext({} as NodeJS.ProcessEnv) as any;
    ctx.getClient = async () => ({ request });
    ctx.policy = { profile: 'full-writes', readOnly: false, allow: [], deny: [] };
    const { server, handlers } = fakeServer();
    buildRegistry(server as never, ctx, 'eager');
    return { handlers, request };
  }

  it('refuses an attachment over the byte limit and says where to get it', async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'mcp-gm-limit-'));
    const prior = process.env.GOOGLE_LOCAL_FILES_DIR;
    process.env.GOOGLE_LOCAL_FILES_DIR = root;
    try {
      const huge = 'A'.repeat(Math.ceil((51 * 1024 * 1024 * 4) / 3));
      const h = ownerHarness((req) => (req.url.includes('/attachments/') ? { data: huge } : { id: 'M1', payload: { parts: [] } }));
      const res = await h.handlers.gmail_download_attachment({ account: 'test', messageId: 'M1', attachmentId: 'ATT1', savePath: 'in' });
      expect(res.isError).toBe(true);
      const out = parseResult(res);
      expect(out.error).toBe('too_large');
      expect(out.hint).toContain('Gmail');
      expect(fs.existsSync(path.join(root, 'in'))).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.GOOGLE_LOCAL_FILES_DIR;
      else process.env.GOOGLE_LOCAL_FILES_DIR = prior;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs at most two downloads at a time and releases the slot after each', async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'mcp-gm-limit-'));
    const prior = process.env.GOOGLE_LOCAL_FILES_DIR;
    process.env.GOOGLE_LOCAL_FILES_DIR = root;
    try {
      let active = 0;
      let peak = 0;
      const h = ownerHarness(async (req) => {
        if (!req.url.includes('/attachments/')) return { id: 'M1', payload: { parts: [] } };
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return { data: Buffer.from('x').toString('base64url') };
      });
      const calls = [1, 2, 3, 4, 5].map((i) =>
        h.handlers.gmail_download_attachment({ account: 'test', messageId: 'M1', attachmentId: `ATT${i}ABCDEFG`, filename: `f${i}.bin`, savePath: 'in' }),
      );
      const results = await Promise.all(calls);
      expect(results.every((r) => !r.isError)).toBe(true);
      expect(peak).toBeLessThanOrEqual(2);
    } finally {
      if (prior === undefined) delete process.env.GOOGLE_LOCAL_FILES_DIR;
      else process.env.GOOGLE_LOCAL_FILES_DIR = prior;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
