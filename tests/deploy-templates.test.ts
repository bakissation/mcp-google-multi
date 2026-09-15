import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf-8');

interface RenderEnvVar {
  key: string;
  value?: string;
  sync?: boolean;
  generateValue?: boolean;
}
interface RenderService {
  type: string;
  runtime?: string;
  autoDeploy?: boolean;
  envVars: RenderEnvVar[];
}

const render = yaml.load(read('render.yaml')) as { services: RenderService[] };
const svc = render.services[0];
const env = new Map(svc.envVars.map((e) => [e.key, e]));

// Secrets + user-specific values that must be prompted, never committed.
const PROMPTED = ['MCP_PUBLIC_URL', 'MCP_OWNER_EMAILS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_ACCOUNTS'];

describe('Render blueprint (B17) — security invariants', () => {
  it('is a docker web service that never auto-deploys', () => {
    expect(svc.type).toBe('web');
    expect(svc.runtime).toBe('docker');
    expect(svc.autoDeploy).toBe(false); // no redeploy on upstream push without the user asking
  });

  it('runs the HTTP transport', () => {
    expect(env.get('MCP_TRANSPORT')?.value).toBe('http');
  });

  it('prompts for every secret (sync:false) and hardcodes none', () => {
    for (const key of PROMPTED) {
      const e = env.get(key);
      expect(e, `${key} must be present`).toBeDefined();
      expect(e!.sync, `${key} must be sync:false`).toBe(false);
      expect(e!.value, `${key} must not carry a literal value`).toBeUndefined();
      expect(e!.generateValue, `${key} is not platform-generated`).toBeUndefined();
    }
  });

  it('generates MASTER_KEY once and never prompts or hardcodes it', () => {
    const mk = env.get('MASTER_KEY');
    expect(mk?.generateValue).toBe(true); // platform mints + persists across redeploys
    expect(mk?.value).toBeUndefined();
    expect(mk?.sync).toBeUndefined();
  });

  it('requires the owner gate (MCP_OWNER_EMAILS is prompted, not defaulted open)', () => {
    const owner = env.get('MCP_OWNER_EMAILS');
    expect(owner?.sync).toBe(false);
    expect(owner?.value).toBeUndefined(); // an empty/blank default must fail startup, not open the server
  });
});

describe('Railway config (B17)', () => {
  const railway = read('railway.toml');

  it('builds the repo Dockerfile', () => {
    expect(railway).toMatch(/builder\s*=\s*"dockerfile"/);
    expect(railway).toMatch(/dockerfilePath\s*=\s*"Dockerfile"/);
  });

  it('carries no inline secret values', () => {
    // Everything sensitive is a dashboard variable; the file only documents them
    // as commented placeholders. No uncommented `KEY = <literal-secret>` line.
    for (const line of railway.split('\n')) {
      const t = line.trim();
      if (t.startsWith('#') || t === '') continue;
      expect(t).not.toMatch(/GOOGLE_CLIENT_SECRET\s*=/);
      expect(t).not.toMatch(/MASTER_KEY\s*=/);
    }
  });
});
