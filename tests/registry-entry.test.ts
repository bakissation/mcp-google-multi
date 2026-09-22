import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = JSON.parse(readFileSync(path.join(root, 'server.json'), 'utf-8'));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));

// The MCP Registry entry (launch checklist A2). Publish is CI-automated on
// STABLE releases; these guards keep the committed template publishable
// (constraints verified against the live registry's validate endpoint).
describe('MCP Registry entry', () => {
  it('server.json name matches the npm ownership proof (package.json mcpName)', () => {
    expect(pkg.mcpName).toBe('io.github.bakissation/mcp-google-multi');
    expect(server.name).toBe(pkg.mcpName);
  });

  it('description fits the registry limit (100 chars, live-validated)', () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it('every package identifier and version carries the 0.0.0 stamp placeholder', () => {
    expect(server.version).toBe('0.0.0');
    for (const p of server.packages) {
      if ('version' in p) expect(p.version).toBe('0.0.0');
      if (p.registryType !== 'npm') expect(p.identifier).toContain('0.0.0');
    }
  });

  it('the npm package points at the published name with stdio transport', () => {
    const npm = server.packages.find((p: { registryType: string }) => p.registryType === 'npm');
    expect(npm.identifier).toBe(pkg.name);
    expect(npm.transport.type).toBe('stdio');
    const names = npm.environmentVariables.map((e: { name: string }) => e.name);
    expect(names).toEqual(expect.arrayContaining(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_ACCOUNTS', 'MASTER_KEY']));
  });

  it('secrets are marked secret', () => {
    for (const p of server.packages) {
      for (const e of p.environmentVariables ?? []) {
        if (['GOOGLE_CLIENT_SECRET', 'MASTER_KEY'].includes(e.name)) expect(e.isSecret).toBe(true);
      }
    }
  });
});
