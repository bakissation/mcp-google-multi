import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareLocalDest, resolveShareNotification } from '../src/tools/drive.js';
import { executeApiMethod, type ApiMethodRef } from '../src/executor.js';

describe('prepareLocalDest', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const p of created.splice(0)) fs.rmSync(p, { recursive: true, force: true });
  });

  it('creates a missing destination directory (recursively)', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gm-dx-'));
    created.push(parent);
    const savePath = path.join(parent, 'a', 'b', 'c');
    expect(fs.existsSync(savePath)).toBe(false);

    const dest = prepareLocalDest(savePath, 'report.pdf');

    expect(fs.existsSync(savePath)).toBe(true);
    expect(dest).toBe(path.join(savePath, 'report.pdf'));
  });

  it('basename-sanitizes the filename so it never escapes savePath', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gm-dx-'));
    created.push(parent);
    const savePath = path.join(parent, 'out');

    for (const malicious of ['../../etc/passwd', '/tmp/evil.sh', 'a/b/c.txt']) {
      const dest = prepareLocalDest(savePath, malicious);
      expect(path.resolve(dest).startsWith(path.resolve(savePath) + path.sep)).toBe(true);
    }
  });
});

describe('resolveShareNotification', () => {
  it('omits the param for anyone/domain permissions', () => {
    expect(resolveShareNotification({ type: 'anyone', role: 'reader' })).toBeUndefined();
    expect(resolveShareNotification({ type: 'domain', role: 'writer', sendNotification: false })).toBeUndefined();
  });

  it('forces notification on ownership transfers (cannot be disabled)', () => {
    expect(resolveShareNotification({ type: 'user', role: 'owner', sendNotification: false })).toBe(true);
    expect(resolveShareNotification({ type: 'user', role: 'writer', transferOwnership: true, sendNotification: false })).toBe(true);
  });

  it('honors the caller flag for regular user/group shares, defaulting to true', () => {
    expect(resolveShareNotification({ type: 'user', role: 'writer' })).toBe(true);
    expect(resolveShareNotification({ type: 'user', role: 'writer', sendNotification: false })).toBe(false);
    expect(resolveShareNotification({ type: 'group', role: 'reader', sendNotification: true })).toBe(true);
  });
});

describe('executeApiMethod binary/export steering', () => {
  const exportMethod: ApiMethodRef = {
    id: 'drive.files.export',
    httpMethod: 'GET',
    path: 'drive/v3/files/{fileId}/export',
    baseUrl: 'https://www.googleapis.com/',
    requiredParams: ['fileId', 'mimeType'],
  };

  async function payload(method: ApiMethodRef, args: Parameters<typeof executeApiMethod>[1]) {
    const res: any = await executeApiMethod(method, args);
    expect(res.isError).toBe(true);
    return JSON.parse(res.content[0].text);
  }

  it('steers drive.files.export to drive_export before any network call', async () => {
    const p = await payload(exportMethod, { account: 'test' });
    expect(p.error).toBe('binary_unsupported');
    expect(p.hint).toContain('drive_export');
  });

  it('still blocks alt=media downloads', async () => {
    const getMethod: ApiMethodRef = {
      id: 'drive.files.get',
      httpMethod: 'GET',
      path: 'drive/v3/files/{fileId}',
      baseUrl: 'https://www.googleapis.com/',
      requiredParams: ['fileId'],
    };
    const p = await payload(getMethod, { account: 'test', queryParams: { alt: 'media' } });
    expect(p.error).toBe('binary_unsupported');
    expect(p.hint).toContain('drive_download');
  });
});
