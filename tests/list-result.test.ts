import { describe, it, expect } from 'vitest';
import { listResult } from '../src/trim.js';

describe('listResult', () => {
  it('reports a complete page as complete, with no hint to act on', () => {
    const r = listResult('files', [{ id: 'a' }, { id: 'b' }]);
    expect(r).toEqual({ files: [{ id: 'a' }, { id: 'b' }], returned: 2, truncated: false });
    expect(r.hint).toBeUndefined();
  });

  it('is truncated when the API hands back a continuation token', () => {
    const r = listResult('events', [{ id: 'a' }], { nextPageToken: 'tok-1' });
    expect(r.truncated).toBe(true);
    expect(r.nextPageToken).toBe('tok-1');
    expect(r.hint).toContain('pageToken');
  });

  it('is truncated when the server total exceeds what came back', () => {
    const r = listResult('members', [{ id: 'a' }], { totalItems: 40 });
    expect(r.truncated).toBe(true);
    expect(r.totalItems).toBe(40);
    expect(r.hint).toContain('1 of 40');
  });

  it('is complete when the server total matches what came back', () => {
    const r = listResult('members', [{ id: 'a' }], { totalItems: 1 });
    expect(r.truncated).toBe(false);
    expect(r.hint).toBeUndefined();
  });

  it('honours an inferred cap for APIs that offer neither token nor total', () => {
    const r = listResult('contacts', [{ id: 'a' }], { capped: true });
    expect(r.truncated).toBe(true);
    expect(r.hint).toContain('may exist');
  });

  // An empty page is a real answer ("this folder is empty"), not a truncation.
  it('treats an empty page as complete', () => {
    expect(listResult('files', [])).toEqual({ files: [], returned: 0, truncated: false });
  });

  it('keeps a caller hint instead of the generic one', () => {
    const r = listResult('files', [], { capped: true, hint: 'Narrow the corpus.' });
    expect(r.hint).toBe('Narrow the corpus.');
  });

  it('places sibling fields beside the list without shadowing the envelope', () => {
    const r = listResult('members', [], { totalItems: 3, extra: { group: 'Friends', fetchFailures: 3 } });
    expect(r.group).toBe('Friends');
    expect(r.fetchFailures).toBe(3);
    expect(r.truncated).toBe(true);
  });

  // The token is what makes the rest reachable; a falsy one must not be
  // advertised as a next page.
  it('omits an absent token rather than emitting null', () => {
    const r = listResult('files', [{ id: 'a' }], { nextPageToken: null });
    expect('nextPageToken' in r).toBe(false);
    expect(r.truncated).toBe(false);
  });
});
