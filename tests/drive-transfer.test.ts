import { describe, it, expect } from 'vitest';
import { transferExportPlan } from '../src/tools/drive.js';

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
