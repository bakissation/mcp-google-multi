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

interface ComposeService {
  image?: string;
  build?: unknown;
  env_file?: string;
  init?: boolean;
  restart?: string;
  profiles?: string[];
  ports?: string[];
  volumes?: string[];
  healthcheck?: { test: string[] };
  depends_on?: Record<string, { condition: string }>;
}
interface ComposeFile {
  services: Record<string, ComposeService>;
  volumes: Record<string, unknown>;
}

describe('Pull-and-up compose (deploy/compose.yaml)', () => {
  const compose = yaml.load(read('deploy/compose.yaml')) as ComposeFile;
  const mcp = compose.services.mcp;
  const caddy = compose.services.caddy;

  it('pulls the published GHCR image pinned to the major, never build:', () => {
    expect(mcp.build).toBeUndefined();
    expect(mcp.image).toMatch(/^ghcr\.io\/bakissation\/mcp-google-multi:\$\{MCP_IMAGE_TAG:-6\}$/);
  });

  it('runs with init + restart + env_file + the persistent config volume', () => {
    expect(mcp.init).toBe(true); // SIGTERM must reach node (distroless has no init)
    expect(mcp.restart).toBe('unless-stopped');
    expect(mcp.env_file).toBe('.env');
    expect(mcp.volumes).toContain('mcp-config:/home/nonroot/.config/mcp-google-multi');
    expect(compose.volumes).toHaveProperty('mcp-config');
  });

  it('publishes the MCP port on loopback only', () => {
    for (const p of mcp.ports ?? []) expect(p).toMatch(/^127\.0\.0\.1:/);
  });

  it('healthchecks via an exec-form node probe (distroless has no shell)', () => {
    const test = mcp.healthcheck?.test ?? [];
    expect(test[0]).toBe('CMD');
    expect(test[1]).toBe('/nodejs/bin/node');
    // No template literals: compose would interpolate ${...} in the script.
    expect(test.join(' ')).not.toContain('${');
  });

  it('gates caddy behind the caddy profile with cert persistence', () => {
    expect(caddy.profiles).toEqual(['caddy']);
    expect(caddy.image).toMatch(/^caddy:2/);
    expect(caddy.ports).toEqual(expect.arrayContaining(['80:80', '443:443', '443:443/udp']));
    expect(caddy.volumes).toEqual(
      expect.arrayContaining(['./Caddyfile:/etc/caddy/Caddyfile:ro', 'caddy-data:/data']),
    );
  });
});

describe('Pull-and-up env template (deploy/.env.example)', () => {
  const envExample = read('deploy/.env.example');

  it('carries every required key and no filled-in secret values', () => {
    for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_ACCOUNTS', 'MCP_OWNER_EMAILS', 'MCP_PUBLIC_URL']) {
      expect(envExample).toMatch(new RegExp(`^${key}=$`, 'm')); // present AND empty
    }
  });

  it('keeps MASTER_KEY and the caddy-profile keys commented out by default', () => {
    expect(envExample).toMatch(/^# MASTER_KEY=/m);
    expect(envExample).toMatch(/^# MCP_DOMAIN=/m);
    expect(envExample).toMatch(/^# MCP_HTTP_HOST=0\.0\.0\.0$/m);
    expect(envExample).not.toMatch(/^MASTER_KEY=.+/m);
  });
});

describe('Caddyfile (deploy/Caddyfile)', () => {
  const caddyfile = read('deploy/Caddyfile');

  it('serves the env-provided domain and proxies to the mcp service', () => {
    expect(caddyfile).toContain('{$MCP_DOMAIN}');
    expect(caddyfile).toContain('reverse_proxy mcp:4243');
  });

  it('keeps MCP streams flushing and reload-safe', () => {
    expect(caddyfile).toContain('flush_interval -1');
    expect(caddyfile).toContain('stream_close_delay');
  });
});
