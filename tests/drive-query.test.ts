import { describe, it, expect } from 'vitest';
import { normalizeDriveQuery, isDriveInvalidQuery, DRIVE_QUERY_HINT } from '../src/tools/drive.js';

describe('normalizeDriveQuery', () => {
  it('wraps a bare keyword as a full-text search', () => {
    expect(normalizeDriveQuery('invoice')).toBe("fullText contains 'invoice'");
    expect(normalizeDriveQuery('  roadmap  ')).toBe("fullText contains 'roadmap'");
  });

  it('wraps a multi-word phrase, including one with bare and/or/in words', () => {
    expect(normalizeDriveQuery('sales and marketing')).toBe("fullText contains 'sales and marketing'");
    expect(normalizeDriveQuery('investing in stocks')).toBe("fullText contains 'investing in stocks'");
  });

  it('wraps a bare name with an apostrophe as full-text, escaping the quote', () => {
    expect(normalizeDriveQuery("O'Brien")).toBe("fullText contains 'O\\'Brien'");
    expect(normalizeDriveQuery('a\\b')).toBe("fullText contains 'a\\\\b'");
  });

  it('passes a structured query through untouched', () => {
    for (const q of [
      "name contains 'MoU'",
      "mimeType = 'application/pdf'",
      "'me' in owners",
      "'folderId' in parents",
      "modifiedTime > '2026-01-01T00:00:00'",
      "name != 'draft'",
      "starred = true and trashed = false",
    ]) {
      expect(normalizeDriveQuery(q)).toBe(q);
    }
  });

  it('returns empty for empty/whitespace input', () => {
    expect(normalizeDriveQuery('')).toBe('');
    expect(normalizeDriveQuery('   ')).toBe('');
  });
});

describe('isDriveInvalidQuery', () => {
  it('matches a 400 "Invalid Value" from the Drive API', () => {
    expect(isDriveInvalidQuery({ code: 400, message: 'Invalid Value' })).toBe(true);
    expect(isDriveInvalidQuery({ response: { status: 400, data: { error: { message: 'Invalid Value' } } } })).toBe(true);
  });

  it('matches a 400 with reason "invalid"/"invalidQuery"', () => {
    expect(isDriveInvalidQuery({ code: 400, errors: [{ reason: 'invalid' }] })).toBe(true);
    expect(isDriveInvalidQuery({ response: { status: 400, data: { error: { errors: [{ reason: 'invalidQuery' }] } } } })).toBe(true);
  });

  it('ignores non-400 errors and unrelated 400s', () => {
    expect(isDriveInvalidQuery({ code: 403, message: 'Invalid Value' })).toBe(false);
    expect(isDriveInvalidQuery({ code: 404, message: 'File not found' })).toBe(false);
    expect(isDriveInvalidQuery({ code: 400, message: 'Some other problem' })).toBe(false);
    expect(isDriveInvalidQuery({})).toBe(false);
  });

  it('exposes a hint that names the fix', () => {
    expect(DRIVE_QUERY_HINT).toMatch(/full-text/i);
    expect(DRIVE_QUERY_HINT).toContain('contains');
  });
});
