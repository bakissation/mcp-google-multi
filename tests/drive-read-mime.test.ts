import { describe, it, expect } from 'vitest';
import { isTextualMime } from '../src/tools/drive.js';

describe('isTextualMime', () => {
  it('accepts text/* including parameterized types', () => {
    for (const m of ['text/plain', 'text/csv', 'text/markdown', 'text/plain; charset=utf-8', 'TEXT/HTML']) {
      expect(isTextualMime(m), m).toBe(true);
    }
  });

  it('accepts RFC 6839 structured-syntax suffixes (the svg regression)', () => {
    for (const m of ['image/svg+xml', 'application/atom+xml', 'application/ld+json', 'application/openapi+yaml']) {
      expect(isTextualMime(m), m).toBe(true);
    }
  });

  it('accepts the bare structured application/* types', () => {
    for (const m of ['application/json', 'application/xml', 'application/javascript', 'application/x-ndjson']) {
      expect(isTextualMime(m), m).toBe(true);
    }
  });

  it('keeps true binaries binary', () => {
    for (const m of ['application/pdf', 'image/png', 'application/zip', 'application/octet-stream', 'video/mp4', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']) {
      expect(isTextualMime(m), m).toBe(false);
    }
  });
});
