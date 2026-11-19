import { describe, it, expect } from 'vitest';
import { toolHarness, parseResult, type GoogleRequest } from './_tool-harness.js';

const posts = (h: ReturnType<typeof toolHarness>) =>
  h.requests().filter((r) => (r.method ?? 'GET').toUpperCase() === 'POST') as GoogleRequest[];

describe('drive_create_shortcut', () => {
  it('creates a shortcut to the target in the given folder, named like the target by default', async () => {
    const h = toolHarness({
      respond: (req) =>
        (req.method ?? 'GET').toUpperCase() === 'GET'
          ? { name: 'Syllabus' }
          : { id: 'sc1', name: 'Syllabus', mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId: 't1' } },
    });
    const res = await h.call('drive_create_shortcut', { account: 'test', targetId: 't1', parentFolderId: 'fold' });
    expect(res.isError).toBeFalsy();
    expect(parseResult(res)).toMatchObject({ id: 'sc1', shortcutDetails: { targetId: 't1' } });
    expect(posts(h)).toHaveLength(1);
    expect(posts(h)[0].data).toEqual({
      name: 'Syllabus',
      mimeType: 'application/vnd.google-apps.shortcut',
      shortcutDetails: { targetId: 't1' },
      parents: ['fold'],
    });
  });

  it('uses shortcutName without reading the target', async () => {
    const h = toolHarness({ respond: () => ({ id: 'sc2' }) });
    await h.call('drive_create_shortcut', { account: 'test', targetId: 't1', shortcutName: 'Link' });
    expect(h.requests().filter((r) => (r.method ?? 'GET').toUpperCase() === 'GET')).toHaveLength(0);
    expect((posts(h)[0].data as { name: string }).name).toBe('Link');
  });

  it('is a create-class tool, allowed under safe-writes', async () => {
    const h = toolHarness({ policy: { profile: 'safe-writes' }, respond: () => ({ id: 'sc3', name: 'x' }) });
    const tool = h.registry.tools.find((t) => t.name === 'drive_create_shortcut');
    expect(tool?.cud).toBe('create');
  });
});

describe('docs_create parentFolderId', () => {
  it('creates in the root through the Docs API when no folder is given', async () => {
    const h = toolHarness({ respond: () => ({ documentId: 'd1', title: 'T' }) });
    const res = await h.call('docs_create', { account: 'test', title: 'T' });
    expect(parseResult(res)).toEqual({ documentId: 'd1', title: 'T' });
    expect(h.requests()[0].url).toContain('docs.googleapis.com');
  });

  it('creates the document inside the folder through Drive', async () => {
    const h = toolHarness({ respond: () => ({ id: 'd2', name: 'T', webViewLink: 'https://docs.google.com/d2' }) });
    const res = await h.call('docs_create', { account: 'test', title: 'T', parentFolderId: 'fold' });
    expect(res.isError).toBeFalsy();
    expect(parseResult(res)).toMatchObject({ documentId: 'd2', title: 'T', parentFolderId: 'fold' });
    expect(posts(h)[0].url).toContain('drive/v3/files');
    expect(posts(h)[0].data).toEqual({ name: 'T', mimeType: 'application/vnd.google-apps.document', parents: ['fold'] });
  });
});
