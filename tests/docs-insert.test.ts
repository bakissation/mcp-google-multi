import { describe, it, expect } from 'vitest';
import { splitInsertText, buildInsertRequests, DOCS_INSERT_CHUNK } from '../src/tools/docs.js';

describe('splitInsertText', () => {
  it('keeps a small insert as a single chunk (unchanged single-request path)', () => {
    expect(splitInsertText('hello')).toEqual(['hello']);
    expect(splitInsertText('x'.repeat(DOCS_INSERT_CHUNK))).toHaveLength(1);
  });

  it('returns no chunks for empty text', () => {
    expect(splitInsertText('')).toEqual([]);
  });

  it('splits a large insert into bounded pieces that rejoin exactly', () => {
    const text = 'x'.repeat(DOCS_INSERT_CHUNK * 2 + 137);
    const chunks = splitInsertText(text);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(DOCS_INSERT_CHUNK);
    expect(chunks.join('')).toBe(text);
  });

  it('handles a large mixed-script (RTL + LTR) insert without loss', () => {
    const text = ('عربي '.repeat(1000) + 'latin tail '.repeat(200));
    expect(splitInsertText(text).join('')).toBe(text);
  });

  it('never splits a surrogate pair', () => {
    const emoji = '😀'; // one astral char = two UTF-16 code units
    const text = emoji.repeat(DOCS_INSERT_CHUNK); // length = 2 * DOCS_INSERT_CHUNK
    const chunks = splitInsertText(text);
    expect(chunks.join('')).toBe(text);
    for (const c of chunks) {
      const last = c.charCodeAt(c.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false); // no dangling high surrogate
      const first = c.charCodeAt(0);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false); // no leading low surrogate
    }
  });
});

describe('buildInsertRequests', () => {
  it('appends at end-of-segment when no index is given', () => {
    const reqs = buildInsertRequests('hello');
    expect(reqs).toEqual([{ insertText: { text: 'hello', endOfSegmentLocation: { segmentId: '' } } }]);
  });

  it('inserts at the given index for a small insert', () => {
    const reqs = buildInsertRequests('hello', 42);
    expect(reqs).toEqual([{ insertText: { text: 'hello', location: { index: 42 } } }]);
  });

  it('advances the cursor by each chunk length for a large indexed insert', () => {
    const text = 'x'.repeat(DOCS_INSERT_CHUNK) + 'y'.repeat(10);
    const reqs = buildInsertRequests(text, 100);
    expect(reqs).toHaveLength(2);
    expect(reqs[0].insertText.location.index).toBe(100);
    expect(reqs[1].insertText.location.index).toBe(100 + DOCS_INSERT_CHUNK);
    expect(reqs[0].insertText.text + reqs[1].insertText.text).toBe(text);
  });

  it('chains end-of-segment appends for a large unindexed insert', () => {
    const text = 'x'.repeat(DOCS_INSERT_CHUNK + 5);
    const reqs = buildInsertRequests(text);
    expect(reqs).toHaveLength(2);
    for (const r of reqs) expect(r.insertText.endOfSegmentLocation).toEqual({ segmentId: '' });
    expect(reqs.map((r) => r.insertText.text).join('')).toBe(text);
  });

  it('produces no requests for empty text', () => {
    expect(buildInsertRequests('')).toEqual([]);
    expect(buildInsertRequests('', 5)).toEqual([]);
  });
});
