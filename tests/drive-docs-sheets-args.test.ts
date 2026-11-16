import { describe, it, expect } from 'vitest';
import { toolHarness, fakeServer, parseResult as parse } from './_tool-harness.js';
import { buildRegistry } from '../src/compose.js';
import { buildIdentityContext } from '../src/identity.js';

describe('drive_search orderBy', () => {
  it('forwards orderBy to files.list when passed', async () => {
    const h = toolHarness({ respond: () => ({ files: [] }) });
    await h.call('drive_search', { account: 'test', query: 'report', orderBy: 'modifiedTime desc' });
    const req = h.requests().find((r) => r.url.includes('/drive/v3/files'));
    expect((req?.params as Record<string, unknown>)?.orderBy).toBe('modifiedTime desc');
  });

  it('omits orderBy when not passed', async () => {
    const h = toolHarness({ respond: () => ({ files: [] }) });
    await h.call('drive_search', { account: 'test', query: 'report' });
    const req = h.requests().find((r) => r.url.includes('/drive/v3/files'));
    expect(req?.params).not.toHaveProperty('orderBy');
  });
});

describe('drive_share local validation', () => {
  it('rejects type=user with no emailAddress, before any request', async () => {
    const h = toolHarness();
    const res = await h.call('drive_share', { account: 'test', fileId: 'F1', type: 'user', role: 'reader' });
    const env = parse(res);
    expect(res.isError).toBe(true);
    expect(env.error).toBe('invalid_params');
    expect(env.message).toContain('emailAddress');
    expect(h.requests()).toHaveLength(0);
  });

  it('rejects type=group with no emailAddress', async () => {
    const h = toolHarness();
    const res = await h.call('drive_share', { account: 'test', fileId: 'F1', type: 'group', role: 'reader' });
    expect(parse(res).error).toBe('invalid_params');
    expect(h.requests()).toHaveLength(0);
  });

  it('rejects type=domain with no domain', async () => {
    const h = toolHarness();
    const res = await h.call('drive_share', { account: 'test', fileId: 'F1', type: 'domain', role: 'reader' });
    const env = parse(res);
    expect(env.error).toBe('invalid_params');
    expect(env.message).toContain('domain');
    expect(h.requests()).toHaveLength(0);
  });

  it('allows type=anyone with neither emailAddress nor domain', async () => {
    const h = toolHarness({ respond: () => ({ id: 'P1', type: 'anyone', role: 'reader' }) });
    const res = await h.call('drive_share', { account: 'test', fileId: 'F1', type: 'anyone', role: 'reader' });
    expect(res.isError).toBeFalsy();
    expect(h.requests()).toHaveLength(1);
  });
});

describe('drive_upload contentBase64', () => {
  it('is registered for a non-owner context (the harness default), without localPath', async () => {
    const h = toolHarness();
    expect(h.handlers.drive_upload).toBeDefined();
    expect(h.schemas.drive_upload).not.toHaveProperty('localPath');
    expect(h.schemas.drive_upload).toHaveProperty('contentBase64');
  });

  it('is registered for the owner context too, with localPath available', async () => {
    const ctx = buildIdentityContext({} as NodeJS.ProcessEnv);
    const { server, handlers, schemas } = fakeServer();
    buildRegistry(server as never, ctx, 'eager');
    expect(handlers.drive_upload).toBeDefined();
    expect(schemas.drive_upload).toHaveProperty('localPath');
    expect(schemas.drive_upload).toHaveProperty('contentBase64');
  });

  it('uploads inline base64 content', async () => {
    const h = toolHarness({ respond: () => ({ id: 'F9', name: 'f.txt', mimeType: 'text/plain', webViewLink: 'https://x' }) });
    const res = await h.call('drive_upload', {
      account: 'test',
      filename: 'f.txt',
      contentBase64: Buffer.from('hello world').toString('base64'),
    });
    expect(res.isError).toBeFalsy();
    expect(parse(res)).toEqual({ id: 'F9', name: 'f.txt', mimeType: 'text/plain', webViewLink: 'https://x' });
    const upload = h.requests().find((r) => r.url.includes('/upload/drive/v3/files'));
    expect(upload).toBeDefined();
  });

  it('accepts inline content between the old 10MB cap and the 25MB cap', async () => {
    const h = toolHarness({ respond: () => ({ id: 'F9', name: 'big.bin', mimeType: 'application/octet-stream', webViewLink: 'https://x' }) });
    const big = Buffer.alloc(12 * 1024 * 1024, 'a').toString('base64');
    const res = await h.call('drive_upload', { account: 'test', filename: 'big.bin', contentBase64: big });
    expect(res.isError).toBeFalsy();
  });

  it('rejects content over the 25MB decoded cap, before any request', async () => {
    const h = toolHarness();
    const big = Buffer.alloc(25 * 1024 * 1024 + 1, 'a').toString('base64');
    const res = await h.call('drive_upload', { account: 'test', filename: 'big.bin', contentBase64: big });
    const env = parse(res);
    expect(res.isError).toBe(true);
    expect(env.error).toBe('invalid_params');
    expect(h.requests()).toHaveLength(0);
  });

  it('rejects when neither contentBase64 nor localPath is passed', async () => {
    const h = toolHarness();
    const res = await h.call('drive_upload', { account: 'test', filename: 'f.txt' });
    expect(parse(res).error).toBe('invalid_params');
    expect(h.requests()).toHaveLength(0);
  });

  it('rejects when localPath is passed on a non-owner context (undeclared, so it reaches the handler as an unknown key)', async () => {
    const h = toolHarness();
    const res = await h.handlers.drive_upload({ account: 'test', filename: 'f.txt', localPath: '/etc/hostname' });
    expect(res.isError).toBe(true);
    expect(h.requests()).toHaveLength(0);
  });
});

describe('docs_replace_text', () => {
  const batchUpdateRespond = (counts: number[]) => (req: { data?: unknown }) => {
    const n = (req.data as { requests?: unknown[] })?.requests?.length ?? counts.length;
    return { documentId: 'D1', replies: Array.from({ length: n }, (_, i) => ({ replaceAllText: { occurrencesChanged: counts[i] ?? 0 } })) };
  };

  it('replaces a single pair as before', async () => {
    const h = toolHarness({ respond: batchUpdateRespond([3]) });
    const res = await h.call('docs_replace_text', { account: 'test', documentId: 'D1', findText: 'a', replaceText: 'b' });
    expect(parse(res)).toEqual({ documentId: 'D1', occurrencesReplaced: 3 });
  });

  it('adds a warning when 0 occurrences were replaced (single pair)', async () => {
    const h = toolHarness({ respond: batchUpdateRespond([0]) });
    const res = await h.call('docs_replace_text', { account: 'test', documentId: 'D1', findText: 'nope', replaceText: 'b' });
    expect(parse(res)).toEqual({ documentId: 'D1', occurrencesReplaced: 0, warning: expect.stringContaining('No occurrences') });
  });

  it('applies several pairs in one batchUpdate and returns per-pair counts', async () => {
    const h = toolHarness({ respond: batchUpdateRespond([2, 0]) });
    const res = await h.call('docs_replace_text', {
      account: 'test',
      documentId: 'D1',
      replacements: [{ findText: 'a', replaceText: 'b' }, { findText: 'c', replaceText: 'd' }],
    });
    expect(parse(res)).toEqual({
      documentId: 'D1',
      replacements: [
        { findText: 'a', replaceText: 'b', occurrencesReplaced: 2 },
        { findText: 'c', replaceText: 'd', occurrencesReplaced: 0 },
      ],
    });
    expect(h.requests()).toHaveLength(1);
  });

  it('adds a warning when every replacements pair replaced 0 occurrences', async () => {
    const h = toolHarness({ respond: batchUpdateRespond([0, 0]) });
    const res = await h.call('docs_replace_text', {
      account: 'test',
      documentId: 'D1',
      replacements: [{ findText: 'a', replaceText: 'b' }, { findText: 'c', replaceText: 'd' }],
    });
    expect(parse(res).warning).toContain('No occurrences');
  });

  it('rejects when both findText/replaceText and replacements are passed', async () => {
    const h = toolHarness();
    const res = await h.call('docs_replace_text', {
      account: 'test',
      documentId: 'D1',
      findText: 'a',
      replaceText: 'b',
      replacements: [{ findText: 'c', replaceText: 'd' }],
    });
    expect(parse(res).error).toBe('invalid_params');
    expect(h.requests()).toHaveLength(0);
  });

  it('rejects when neither form is passed', async () => {
    const h = toolHarness();
    const res = await h.call('docs_replace_text', { account: 'test', documentId: 'D1' });
    expect(parse(res).error).toBe('invalid_params');
    expect(h.requests()).toHaveLength(0);
  });
});

describe('sheets_format_cells with an A1 range string', () => {
  const metaRespond = (sheets: { sheetId: number; title: string }[]) => (req: { url: string }) => {
    if (/\/v4\/spreadsheets\/[^/:]+$/.test(req.url)) {
      return { sheets: sheets.map((s) => ({ properties: { sheetId: s.sheetId, title: s.title } })) };
    }
    return {};
  };

  it('resolves the sheet title to a sheetId and the A1 span to indexes', async () => {
    const h = toolHarness({ respond: metaRespond([{ sheetId: 42, title: 'Sheet1' }]) });
    const res = await h.call('sheets_format_cells', {
      account: 'test',
      spreadsheetId: 'S1',
      range: 'Sheet1!A1:D10',
      backgroundColor: { red: 1 },
    });
    expect(res.isError).toBeFalsy();
    const batch = h.requests().find((r) => r.url.includes(':batchUpdate'));
    const range = (batch?.data as { requests: [{ repeatCell: { range: unknown } }] }).requests[0].repeatCell.range;
    expect(range).toEqual({ sheetId: 42, startRowIndex: 0, endRowIndex: 10, startColumnIndex: 0, endColumnIndex: 4 });
  });

  it('still accepts a GridRange object directly, with no extra lookup', async () => {
    const h = toolHarness({ respond: () => ({}) });
    const res = await h.call('sheets_format_cells', {
      account: 'test',
      spreadsheetId: 'S1',
      range: { sheetId: 7, startRowIndex: 0, endRowIndex: 1 },
      backgroundColor: { red: 1 },
    });
    expect(res.isError).toBeFalsy();
    expect(h.requests().some((r) => /\/v4\/spreadsheets\/[^/:]+$/.test(r.url))).toBe(false);
    const batch = h.requests().find((r) => r.url.includes(':batchUpdate'));
    const range = (batch?.data as { requests: [{ repeatCell: { range: unknown } }] }).requests[0].repeatCell.range;
    expect(range).toEqual({ sheetId: 7, startRowIndex: 0, endRowIndex: 1 });
  });

  it('rejects an A1 string naming a sheet/tab that does not exist', async () => {
    const h = toolHarness({ respond: metaRespond([{ sheetId: 42, title: 'Sheet1' }]) });
    const res = await h.call('sheets_format_cells', {
      account: 'test',
      spreadsheetId: 'S1',
      range: 'NoSuchTab!A1:D10',
      backgroundColor: { red: 1 },
    });
    const env = parse(res);
    expect(env.error).toBe('invalid_params');
    expect(env.message).toContain('NoSuchTab');
    expect(h.requests().some((r) => r.url.includes(':batchUpdate'))).toBe(false);
  });
});

describe('parseA1Range', () => {
  it('parses a full cell range with a sheet name', async () => {
    const { parseA1Range } = await import('../src/tools/sheets.js');
    expect(parseA1Range('Sheet1!A1:D10')).toEqual({
      sheetName: 'Sheet1',
      startColumnIndex: 0,
      endColumnIndex: 4,
      startRowIndex: 0,
      endRowIndex: 10,
    });
  });

  it('parses a whole-column range', async () => {
    const { parseA1Range } = await import('../src/tools/sheets.js');
    expect(parseA1Range('Sheet1!B:D')).toEqual({ sheetName: 'Sheet1', startColumnIndex: 1, endColumnIndex: 4 });
  });

  it('parses a whole sheet with no range part', async () => {
    const { parseA1Range } = await import('../src/tools/sheets.js');
    expect(parseA1Range('Sheet1')).toEqual({ sheetName: 'Sheet1' });
  });

  it('unquotes a sheet name quoted for embedded spaces', async () => {
    const { parseA1Range } = await import('../src/tools/sheets.js');
    expect(parseA1Range("'My Sheet'!A1")).toEqual({
      sheetName: 'My Sheet',
      startColumnIndex: 0,
      endColumnIndex: 1,
      startRowIndex: 0,
      endRowIndex: 1,
    });
  });
});

describe('sheets_copy_sheet_to', () => {
  it('copies a sheet into another spreadsheet and returns the new sheet properties', async () => {
    const h = toolHarness({ respond: () => ({ sheetId: 99, title: 'Sheet1', index: 3 }) });
    const res = await h.call('sheets_copy_sheet_to', {
      account: 'test',
      spreadsheetId: 'SRC',
      sheetId: 1,
      destinationSpreadsheetId: 'DST',
    });
    expect(res.isError).toBeFalsy();
    expect(parse(res)).toEqual({ sheetId: 99, title: 'Sheet1', index: 3 });
    const req = h.requests().find((r) => r.url.includes(':copyTo'));
    expect(req?.url).toBe('https://sheets.googleapis.com/v4/spreadsheets/SRC/sheets/1:copyTo');
    expect((req?.data as { destinationSpreadsheetId?: string })?.destinationSpreadsheetId).toBe('DST');
  });
});

describe('drive_upload contentBase64 length validation', () => {
  it('rejects contentBase64 whose string length exceeds the encoding overhead cap, before decoding', async () => {
    const h = toolHarness();
    const MAX_UPLOAD_BASE64_BYTES = 25 * 1024 * 1024;
    const maxB64Length = Math.ceil(MAX_UPLOAD_BASE64_BYTES / 3) * 4 + 4;
    const oversized = 'a'.repeat(maxB64Length + 1);
    const res = await h.call('drive_upload', { account: 'test', filename: 'big.bin', contentBase64: oversized });
    const env = parse(res);
    expect(res.isError).toBe(true);
    expect(env.error).toBe('invalid_params');
    expect(h.requests()).toHaveLength(0);
  });
});

describe('drive_upload with both contentBase64 and localPath', () => {
  it('rejects when both contentBase64 and localPath are passed, with owner context', async () => {
    const ctx = buildIdentityContext({ GOOGLE_PROFILE: 'full-writes' } as NodeJS.ProcessEnv);
    const { server, handlers } = fakeServer();
    buildRegistry(server as never, ctx, 'eager');
    const res = await handlers.drive_upload({ account: 'test', filename: 'f.txt', contentBase64: Buffer.from('hello').toString('base64'), localPath: '/etc/hostname' });
    expect(res.isError).toBe(true);
    expect(parse(res).error).toBe('invalid_params');
  });
});

describe('docs_replace_text with empty replacements array', () => {
  it('rejects an empty replacements array, before any request', async () => {
    const h = toolHarness();
    const res = await h.call('docs_replace_text', { account: 'test', documentId: 'D1', replacements: [] });
    const env = parse(res);
    expect(res.isError).toBe(true);
    expect(env.error).toBe('invalid_params');
    expect(h.requests()).toHaveLength(0);
  });
});

describe('parseA1Range with sheet title containing exclamation mark', () => {
  it("parses \"'Q1!Plan'!A1:B2\" correctly with sheet name Q1!Plan", async () => {
    const { parseA1Range } = await import('../src/tools/sheets.js');
    expect(parseA1Range("'Q1!Plan'!A1:B2")).toEqual({
      sheetName: 'Q1!Plan',
      startColumnIndex: 0,
      endColumnIndex: 2,
      startRowIndex: 0,
      endRowIndex: 2,
    });
  });
});

