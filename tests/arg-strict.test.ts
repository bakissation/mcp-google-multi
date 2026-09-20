import { describe, it, expect } from 'vitest';
import {
  isExemptKey,
  screenArguments,
  suggestKeys,
  unknownArgEnvelope,
  unknownArgMode,
} from '../src/arg-strict.js';

// Declared key lists copied from the real tool schemas (src/tools/drive.ts).
const DRIVE_CREATE_FOLDER = ['account', 'name', 'parentFolderId'];
const DRIVE_LIST = ['account', 'folderId', 'maxResults'];
const DRIVE_MOVE = ['account', 'fileId', 'newParentFolderId'];
const DRIVE_UPLOAD = ['account', 'localPath', 'filename', 'mimeType', 'convertTo', 'parentFolderId'];

describe('unknownArgMode', () => {
  it('defaults to warn (the staged rollout: observe before rejecting)', () => {
    expect(unknownArgMode({})).toBe('warn');
    expect(unknownArgMode({ GOOGLE_ARG_UNKNOWN: '' })).toBe('warn');
  });
  it('accepts the three modes, case-insensitively and trimmed', () => {
    expect(unknownArgMode({ GOOGLE_ARG_UNKNOWN: ' Reject ' })).toBe('reject');
    expect(unknownArgMode({ GOOGLE_ARG_UNKNOWN: 'OFF' })).toBe('off');
    expect(unknownArgMode({ GOOGLE_ARG_UNKNOWN: 'warn' })).toBe('warn');
  });
  it('fails OPEN to warn on nonsense, since the safe state changes no behavior', () => {
    expect(unknownArgMode({ GOOGLE_ARG_UNKNOWN: 'maybe' })).toBe('warn');
  });
});

describe('suggestKeys', () => {
  // The motivating case. Plain edit distance cannot reach it:
  // editDistance('parentid','parentfolderid') is 6.
  it('resolves the field-reported typo on every tool that declares the concept', () => {
    expect(suggestKeys('parentId', DRIVE_CREATE_FOLDER)).toEqual(['parentFolderId']);
    expect(suggestKeys('parentId', DRIVE_UPLOAD)).toEqual(['parentFolderId']);
    expect(suggestKeys('parentId', DRIVE_MOVE)).toEqual(['newParentFolderId']);
  });

  it('stays SILENT where the concept is genuinely ambiguous', () => {
    // drive_list's folder key is spelled folderId; parentId is not close
    // enough to claim, which is exactly why the sibling hint exists.
    expect(suggestKeys('parentId', DRIVE_LIST)).toEqual([]);
  });

  it('handles case and separator variants (tier 0)', () => {
    for (const v of ['ParentFolderID', 'parent_folder_id', 'parent-folder-id']) {
      expect(suggestKeys(v, DRIVE_CREATE_FOLDER)).toEqual(['parentFolderId']);
    }
  });

  it('handles ordinary typos (tier 3)', () => {
    expect(suggestKeys('accont', DRIVE_LIST)).toEqual(['account']);
    expect(suggestKeys('folderID', DRIVE_LIST)).toEqual(['folderId']);
  });

  it('never invents a key that the tool does not declare', () => {
    for (const probe of ['parentId', 'parents', 'recipients', 'limit', 'folder', 'path', 'name']) {
      for (const declared of [DRIVE_CREATE_FOLDER, DRIVE_LIST, DRIVE_MOVE, DRIVE_UPLOAD]) {
        for (const s of suggestKeys(probe, declared)) {
          expect(declared, `${probe} -> ${s}`).toContain(s);
        }
      }
    }
  });

  it('offers nothing for genuinely invented arguments', () => {
    expect(suggestKeys('completely_made_up_arg', DRIVE_CREATE_FOLDER)).toEqual([]);
    expect(suggestKeys('recipients', DRIVE_LIST)).toEqual([]);
  });

  it('caps the suggestion list', () => {
    expect(suggestKeys('account', ['toAccount', 'fromAccount', 'accountAlias']).length).toBeLessThanOrEqual(2);
  });
});

describe('isExemptKey', () => {
  it('exempts metadata and vendor-namespaced keys', () => {
    expect(isExemptKey('_meta')).toBe(true);
    expect(isExemptKey('anthropic/requiresUserInteraction')).toBe(true);
  });
  it('does NOT exempt dotted keys, which are real declared parameters', () => {
    expect(isExemptKey('groupKey.id')).toBe(false);
    expect(isExemptKey('parentId')).toBe(false);
  });
});

describe('screenArguments', () => {
  it('flags the field-reported call and leaves the correct one alone', () => {
    const bad = screenArguments('drive_create_folder', { account: 'w', name: 'R', parentId: 'F' }, DRIVE_CREATE_FOLDER);
    expect(bad.unknown.map((u) => u.sent)).toEqual(['parentId']);
    expect(bad.unknown[0].suggestions).toEqual(['parentFolderId']);

    const good = screenArguments('drive_create_folder', { account: 'w', name: 'R', parentFolderId: 'F' }, DRIVE_CREATE_FOLDER);
    expect(good.unknown).toEqual([]);
    expect(good.redundant).toEqual([]);
  });

  it('treats a redundant duplicate as a drop, never a rejection', () => {
    // The declared key already won, so this call behaves as it always has.
    const r = screenArguments('drive_create_folder', { account: 'w', name: 'R', parentFolderId: 'F', parentId: 'F' }, DRIVE_CREATE_FOLDER);
    expect(r.unknown).toEqual([]);
    expect(r.redundant).toEqual(['parentId']);
  });

  it('never screens a tool that declares no arguments', () => {
    const r = screenArguments('discover_all', { random_string: 'dummy' }, []);
    expect(r.unknown).toEqual([]);
  });

  it('ignores exempt keys', () => {
    const r = screenArguments('drive_list', { account: 'w', _meta: {}, 'anthropic/x': 1 }, DRIVE_LIST);
    expect(r.unknown).toEqual([]);
  });
});

describe('unknownArgEnvelope', () => {
  it('names the tool, the key and states that nothing was sent', () => {
    const e = unknownArgEnvelope(
      'drive_create_folder',
      [{ sent: 'parentId', suggestions: ['parentFolderId'] }],
      DRIVE_CREATE_FOLDER,
      'work',
    );
    expect(e.error).toBe('unknown_argument');
    expect(e.message).toContain('drive_create_folder does not accept "parentId"');
    expect(e.message).toContain('Nothing was sent to Google');
    expect(e.hint).toContain('Did you mean "parentFolderId"?');
    expect(e.hint).toContain('This tool accepts: account, name, parentFolderId.');
    expect(e.retriable).toBe(false);
    expect(e.account).toBe('work');
  });

  it('falls back to sibling spellings when nothing matched', () => {
    const e = unknownArgEnvelope(
      'drive_list',
      [{ sent: 'parentId', suggestions: [] }],
      DRIVE_LIST,
      'work',
      [{ key: 'parentFolderId', tools: ['drive_upload', 'drive_create_folder', 'drive_copy'] }],
    );
    expect(e.hint).toContain('This tool accepts: account, folderId, maxResults.');
    expect(e.hint).toContain('"parentFolderId" (drive_upload, drive_create_folder, drive_copy)');
  });

  it('degrades to the accepted-key list when there is nothing else to say', () => {
    const e = unknownArgEnvelope('drive_create_folder', [{ sent: 'zzz', suggestions: [] }], DRIVE_CREATE_FOLDER, undefined);
    expect(e.hint).toBe('This tool accepts: account, name, parentFolderId.');
    expect(e.account).toBeUndefined();
  });

  it('never leaks an argument VALUE', () => {
    const e = unknownArgEnvelope(
      'drive_create_folder',
      [{ sent: 'parentId', suggestions: ['parentFolderId'] }],
      DRIVE_CREATE_FOLDER,
      'work',
    );
    const blob = JSON.stringify(e);
    expect(blob).not.toContain('SECRET_FOLDER_VALUE');
    expect(blob).not.toContain('1a2b3c');
  });
});
