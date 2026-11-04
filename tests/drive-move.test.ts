import { describe, it, expect } from 'vitest';
import { toolHarness, parseResult, type GoogleRequest } from './_tool-harness.js';

// A tiny Drive: every file starts in "old", GETs report its parents, PATCHes
// (files.update) are recorded. "bad" does not exist.
function drive(parents: Record<string, string[]> = {}) {
  return (req: GoogleRequest): unknown => {
    const id = decodeURIComponent(req.url.split('/files/')[1]?.split('?')[0] ?? '');
    if (id === 'bad') {
      throw Object.assign(new Error('File not found: bad.'), {
        code: 404,
        response: { status: 404, data: { error: { code: 404, message: 'File not found: bad.', errors: [{ reason: 'notFound' }] } } },
      });
    }
    if ((req.method ?? 'GET').toUpperCase() === 'GET') return { parents: parents[id] ?? ['old'] };
    return { id, name: `name-${id}`, parents: [String(req.params?.addParents)] };
  };
}

const patches = (h: ReturnType<typeof toolHarness>) =>
  h.requests().filter((r) => (r.method ?? 'GET').toUpperCase() === 'PATCH') as GoogleRequest[];

describe('drive_move', () => {
  it('moves one file with fileId and returns that file, as before', async () => {
    const h = toolHarness({ respond: drive() });
    const res = await h.call('drive_move', { account: 'test', fileId: 'f1', newParentFolderId: 'dest' });
    expect(res.isError).toBeFalsy();
    expect(parseResult(res)).toMatchObject({ id: 'f1', parents: ['dest'] });
    expect(patches(h)).toHaveLength(1);
    expect(patches(h)[0].params).toMatchObject({ addParents: 'dest', removeParents: 'old' });
  });

  it('moves every file in fileIds into the folder and reports each one', async () => {
    const h = toolHarness({ respond: drive() });
    const res = await h.call('drive_move', { account: 'test', fileIds: ['a', 'b', 'c'], newParentFolderId: 'dest' });
    expect(res.isError).toBeFalsy();
    const out = parseResult(res) as { moved: number; failed: number; results: Array<{ fileId: string; ok: boolean }> };
    expect(out.moved).toBe(3);
    expect(out.failed).toBe(0);
    expect(out.results.map((r) => r.fileId)).toEqual(['a', 'b', 'c']);
    expect(patches(h)).toHaveLength(3);
  });

  it('accepts fileIds as a JSON string and drops duplicates', async () => {
    const h = toolHarness({ respond: drive() });
    const res = await h.call('drive_move', { account: 'test', fileId: 'a', fileIds: '["a","b"]', newParentFolderId: 'dest' });
    expect((parseResult(res) as { moved: number }).moved).toBe(2);
    expect(patches(h)).toHaveLength(2);
  });

  it('one failing file does not undo or block the others', async () => {
    const h = toolHarness({ respond: drive() });
    const res = await h.call('drive_move', { account: 'test', fileIds: ['a', 'bad', 'c'], newParentFolderId: 'dest' });
    expect(res.isError).toBeFalsy();
    const out = parseResult(res) as { moved: number; failed: number; results: Array<{ fileId: string; ok: boolean; error?: string }> };
    expect(out).toMatchObject({ moved: 2, failed: 1 });
    expect(out.results.find((r) => r.fileId === 'bad')).toMatchObject({ ok: false, error: 'not_found' });
    expect(patches(h)).toHaveLength(2);
  });

  it('is an error only when nothing moved', async () => {
    const h = toolHarness({ respond: drive() });
    const res = await h.call('drive_move', { account: 'test', fileIds: ['bad'], newParentFolderId: 'dest' });
    expect(res.isError).toBe(true);
    expect((parseResult(res) as { failed: number }).failed).toBe(1);
  });

  it('does not remove the destination from the parents when the file is already there', async () => {
    const h = toolHarness({ respond: drive({ f1: ['dest', 'other'] }) });
    await h.call('drive_move', { account: 'test', fileId: 'f1', newParentFolderId: 'dest' });
    expect(patches(h)[0].params).toMatchObject({ addParents: 'dest', removeParents: 'other' });
  });

  it('refuses no file, and more than the per-call cap, before calling Google', async () => {
    for (const args of [
      { account: 'test', newParentFolderId: 'dest' },
      { account: 'test', fileIds: [], newParentFolderId: 'dest' },
      { account: 'test', fileIds: Array.from({ length: 51 }, (_, i) => `f${i}`), newParentFolderId: 'dest' },
    ]) {
      const h = toolHarness({ respond: drive() });
      const res = await h.call('drive_move', args);
      expect(res.isError).toBe(true);
      expect(parseResult(res).error).toBe('invalid_params');
      expect(h.request).not.toHaveBeenCalled();
    }
  });
});
