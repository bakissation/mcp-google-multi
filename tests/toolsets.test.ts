import { describe, it, expect } from 'vitest';
import { getToolsets, toolsetEnabled } from '../src/toolsets.js';

describe('getToolsets', () => {
  it('defaults to all when unset, empty, or "all"', () => {
    expect(getToolsets({})).toBe('all');
    expect(getToolsets({ GOOGLE_TOOLSETS: '' })).toBe('all');
    expect(getToolsets({ GOOGLE_TOOLSETS: '  ' })).toBe('all');
    expect(getToolsets({ GOOGLE_TOOLSETS: 'ALL' })).toBe('all');
  });

  it('parses a CSV list, trimming and lowercasing', () => {
    const sets = getToolsets({ GOOGLE_TOOLSETS: ' Gmail, drive ,,sheets ' });
    expect(sets).toEqual(new Set(['gmail', 'drive', 'sheets']));
  });

  it('treats "all" as the wildcard wherever it appears', () => {
    expect(getToolsets({ GOOGLE_TOOLSETS: 'all,' })).toBe('all');
    expect(getToolsets({ GOOGLE_TOOLSETS: 'all,gmail' })).toBe('all');
    expect(getToolsets({ GOOGLE_TOOLSETS: 'gmail,ALL' })).toBe('all');
  });

  it('a CSV of only separators falls back to all', () => {
    expect(getToolsets({ GOOGLE_TOOLSETS: ',' })).toBe('all');
    expect(getToolsets({ GOOGLE_TOOLSETS: ' , , ' })).toBe('all');
  });
});

describe('toolsetEnabled', () => {
  it('all enables everything', () => {
    expect(toolsetEnabled('all', 'gmail')).toBe(true);
  });

  it('a list enables only its members', () => {
    const sets = new Set(['gmail']);
    expect(toolsetEnabled(sets, 'gmail')).toBe(true);
    expect(toolsetEnabled(sets, 'drive')).toBe(false);
  });
});
