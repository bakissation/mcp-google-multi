import { describe, it, expect } from 'vitest';
import {
  echoNames,
  isExemptKey,
  MAX_SUGGESTED_KEYS,
  screenArguments,
  suggestKeys,
  unknownArgEnvelope,
  unknownArgMode,
} from '../src/arg-strict.js';
import { editDistance, SUGGEST_MAX_INPUT } from '../src/scope-catalog.js';

// Declared key lists copied from the real tool schemas (src/tools/drive.ts).
const DRIVE_CREATE_FOLDER = ['account', 'name', 'parentFolderId'];
const DRIVE_LIST = ['account', 'folderId', 'maxResults', 'pageToken'];
const DRIVE_MOVE = ['account', 'fileId', 'newParentFolderId'];
const DRIVE_UPLOAD = ['account', 'localPath', 'filename', 'mimeType', 'convertTo', 'parentFolderId'];

describe('unknownArgMode', () => {
  it('defaults to reject: a silent drop reads to the client as success', () => {
    expect(unknownArgMode({})).toBe('reject');
    expect(unknownArgMode({ GOOGLE_ARG_UNKNOWN: '' })).toBe('reject');
  });
  it('accepts the three modes, case-insensitively and trimmed', () => {
    expect(unknownArgMode({ GOOGLE_ARG_UNKNOWN: ' Reject ' })).toBe('reject');
    expect(unknownArgMode({ GOOGLE_ARG_UNKNOWN: 'OFF' })).toBe('off');
    expect(unknownArgMode({ GOOGLE_ARG_UNKNOWN: 'warn' })).toBe('warn');
  });
  // Deliberately NOT the default: a misspelled setting is not a request for
  // the strict behavior, and a config typo should not start failing calls.
  it('falls back to warn on a nonsense value, not to the default', () => {
    expect(unknownArgMode({ GOOGLE_ARG_UNKNOWN: 'maybe' })).toBe('warn');
    expect(unknownArgMode({ GOOGLE_ARG_UNKNOWN: 'rejcet' })).toBe('warn');
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

// Caller-controlled names reach an O(n*m) edit distance. Unbounded, one
// megabyte-long key blocked the event loop for seconds (and a tool name for
// minutes); these budgets are orders of magnitude above the bounded cost.
describe('suggestion work is bounded on caller input', () => {
  it('computes edit distance exactly inside the bound and caps it outside', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('parentid', 'parentfolderid')).toBe(6);
    const long = 'a'.repeat(SUGGEST_MAX_INPUT + 1);
    expect(editDistance(long, 'a')).toBe(long.length);
    expect(editDistance('a', long)).toBe(long.length);
  });

  it('gives up on a name no declared key could be a typo of', () => {
    const t0 = performance.now();
    expect(suggestKeys('9'.repeat(1_000_000), DRIVE_UPLOAD)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(250);
  });

  it('ranks only the first few unknown keys of a call and still rejects all of them', () => {
    const args: Record<string, unknown> = { account: 'w' };
    for (let i = 0; i < 20_000; i++) args[`${'9'.repeat(30)}${i}`] = 1;
    args.parentId = 'F';
    const t0 = performance.now();
    const r = screenArguments('drive_create_folder', args, DRIVE_CREATE_FOLDER);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.unknown).toHaveLength(20_001);
    // Beyond the budget a key is still unknown, just without a suggestion.
    expect(r.unknown.at(-1)).toEqual({ sent: 'parentId', suggestions: [] });
  });

  it('recognises a redundant twin past the ranking budget, so a working call still forwards', () => {
    // Each camelCase key sent alongside its snake_case twin: the declared one
    // wins, as it always has. The 9th twin must not become an unknown key.
    const declared = Array.from({ length: 10 }, (_, i) => `indentLevel${String.fromCharCode(65 + i)}`);
    const args: Record<string, unknown> = {};
    for (const k of declared) {
      args[k] = 1;
      args[k.replace(/([A-Z])/g, '_$1').toLowerCase()] = 1;
    }
    const r = screenArguments('docs_update_paragraph_style', args, declared);
    expect(r.unknown).toEqual([]);
    expect(r.redundant).toHaveLength(10);
  });

  it('a max-length unknown name against every tool name costs almost nothing', () => {
    const names = Array.from({ length: 400 }, (_, i) => `service${i % 20}_resource_method_${i}`);
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) suggestKeys(`${'q'.repeat(SUGGEST_MAX_INPUT - 4)}${i}`.slice(0, SUGGEST_MAX_INPUT), names, 3);
    // 200 full DPs against 400 names took seconds; the length-gap skip avoids them
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('keeps suggesting for a call inside the budget', () => {
    const r = screenArguments('drive_create_folder', { account: 'w', parentId: 'F', nme: 'R' }, DRIVE_CREATE_FOLDER);
    expect(r.unknown.map((u) => u.suggestions)).toEqual([['parentFolderId'], ['name']]);
  });

  it('echoes a bounded prefix of what was sent', () => {
    const names = Array.from({ length: MAX_SUGGESTED_KEYS + 5 }, (_, i) => `k${i}`);
    expect(echoNames(names)).toBe(`${names.slice(0, MAX_SUGGESTED_KEYS).join(', ')} and 5 more`);
    expect(echoNames(['x'.repeat(10_000)], true)).toBe(`"${'x'.repeat(64)}..."`);
    const e = unknownArgEnvelope('drive_list', [{ sent: 'q'.repeat(1_000_000), suggestions: [] }], DRIVE_LIST, 'w');
    expect(e.message.length).toBeLessThan(200);
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
    expect(e.hint).toContain('This tool accepts: account, folderId, maxResults, pageToken.');
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
