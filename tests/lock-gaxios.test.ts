import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Two gaxios majors in one tree hand auth clients built on one major to code
// built on the other (#331). Dependabot or a hand edit must not bring the
// second copy back unnoticed.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('package-lock.json', () => {
  it('resolves a single gaxios version', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string }>;
    };
    const versions = new Set<string>();
    for (const [key, pkg] of Object.entries(lock.packages)) {
      if (key === 'node_modules/gaxios' || key.endsWith('/node_modules/gaxios')) versions.add(pkg.version ?? '?');
    }
    expect([...versions]).toHaveLength(1);
  });
});
