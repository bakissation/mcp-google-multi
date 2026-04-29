import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

// Pins the `path.basename` sanitization contract used by every tool that
// writes caller-supplied filenames to disk.

describe('path.basename sanitization', () => {
  it('passes a plain filename through unchanged', () => {
    expect(path.basename('report.xlsx')).toBe('report.xlsx');
  });

  it('strips parent-directory traversal segments', () => {
    expect(path.basename('../../etc/passwd')).toBe('passwd');
    expect(path.basename('../../../../tmp/evil.sh')).toBe('evil.sh');
  });

  it('strips absolute path prefixes (Unix)', () => {
    expect(path.basename('/etc/cron.daily/evil')).toBe('evil');
    expect(path.basename('/home/user/.ssh/authorized_keys')).toBe('authorized_keys');
  });

  it('strips nested directory components', () => {
    expect(path.basename('a/b/c/d.txt')).toBe('d.txt');
  });

  it('with savePath join, never escapes the directory', () => {
    const savePath = '/home/user/Downloads';
    const malicious = ['../../etc/passwd', '/tmp/evil', 'a/b/c/d.txt'];
    for (const f of malicious) {
      const safe = path.basename(f);
      const dest = path.join(savePath, safe);
      // Resolved dest must start with savePath + separator
      expect(path.resolve(dest).startsWith(path.resolve(savePath) + path.sep)).toBe(true);
    }
  });

  it('preserves UTF-8 filenames', () => {
    expect(path.basename('تقرير.pdf')).toBe('تقرير.pdf');
    expect(path.basename('résumé.docx')).toBe('résumé.docx');
  });
});
