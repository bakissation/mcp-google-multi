import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf-8'));

describe('MCPB manifest (B18)', () => {
  it('declares manifest_version 0.3 and the required top-level fields', () => {
    expect(manifest.manifest_version).toBe('0.3');
    for (const key of ['name', 'version', 'description', 'author', 'server']) {
      expect(manifest[key]).toBeTruthy();
    }
    expect(manifest.name).toBe('mcp-google-multi');
  });

  it('is a stdio node server pointing at the built entry point', () => {
    expect(manifest.server.type).toBe('node');
    expect(manifest.server.entry_point).toBe('dist/index.js');
    expect(manifest.server.mcp_config.command).toBe('node');
    expect(manifest.server.mcp_config.args).toContain('${__dirname}/dist/index.js');
  });

  it('marks the two secrets sensitive (keychain-stored, never plaintext)', () => {
    expect(manifest.user_config.google_client_secret.sensitive).toBe(true);
    expect(manifest.user_config.master_key.sensitive).toBe(true);
    // the client ID and accounts are not secrets
    expect(manifest.user_config.google_client_id.sensitive).toBeFalsy();
    expect(manifest.user_config.google_accounts.sensitive).toBeFalsy();
  });

  it('injects every secret via user_config templating, never a hardcoded value', () => {
    const env = manifest.server.mcp_config.env as Record<string, string>;
    for (const [, v] of Object.entries(env)) {
      expect(v).toMatch(/^\$\{user_config\.[a-z_]+\}$/);
    }
    expect(env.GOOGLE_CLIENT_SECRET).toBe('${user_config.google_client_secret}');
    expect(env.MASTER_KEY).toBe('${user_config.master_key}');
  });

  it('requires Node >= 22 (matches engines)', () => {
    expect(manifest.compatibility.runtimes.node).toMatch(/>=\s*22/);
  });

  it('contains no plaintext secret-looking values', () => {
    const raw = readFileSync(path.join(root, 'manifest.json'), 'utf-8');
    // base64-32 keys, long hex, or an @-address would signal a leaked secret
    expect(raw).not.toMatch(/[A-Za-z0-9+/]{43}=/); // base64 32-byte
    expect(raw).not.toMatch(/\b[a-f0-9]{40,}\b/i);
  });
});
