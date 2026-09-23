import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { signAccessToken, jwtSecretFrom } from '../src/mcp-token.js';

// S1.23: the ONE multi-process smoke. Every other HTTP test drives
// HttpTransportHost in-process; the real index.ts HTTP bootstrap (env gates ->
// owner gate -> JWT key provisioning -> AS mounting -> listener) had never
// been exercised end to end. No network leaves the box: the test signs its own
// bearer with the MCP_JWT_KEY it hands the subprocess, and the /authorize leg
// stops at the 302 (the Google URL is built, never fetched).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const srcIndex = path.resolve(repoRoot, 'src', 'index.ts');
const JWT_KEY = 'http-smoke-jwt-key';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function request(
  port: number,
  method: string,
  reqPath: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const data = opts.body !== undefined ? Buffer.from(opts.body) : undefined;
    const r = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path: reqPath,
        headers: { ...(data ? { 'content-length': String(data.length) } : {}), ...opts.headers },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

describe('index.ts HTTP bootstrap smoke (S1.23, subprocess)', () => {
  let child: ChildProcess | undefined;
  let home: string | undefined;

  afterEach(() => {
    child?.kill('SIGTERM');
    child = undefined;
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  it('boots the real server and serves health, metadata, auth and an authenticated /mcp', { timeout: 60_000 }, async () => {
    const port = await freePort();
    const publicUrl = `http://127.0.0.1:${port}`;
    home = mkdtempSync(path.join(tmpdir(), 'mcp-gm-httpsmoke-'));
    const emptyEnv = path.join(home, 'empty.env');
    writeFileSync(emptyEnv, '');

    const env = { ...process.env } as NodeJS.ProcessEnv;
    for (const k of ['GOOGLE_ADMIN_ACCOUNTS', 'GOOGLE_OPTIONAL_SCOPES', 'GOOGLE_DEFAULT_ACCOUNT']) delete env[k];
    Object.assign(env, {
      XDG_CONFIG_HOME: home,
      TOKEN_STORE_PATH: path.join(home, 'tokens'),
      MCP_GOOGLE_MULTI_ENV: emptyEnv,
      GOOGLE_ACCOUNTS: 'test:test@example.com',
      GOOGLE_CLIENT_ID: 'smoke-client-id',
      GOOGLE_CLIENT_SECRET: 'smoke-client-secret',
      MASTER_KEY: 'http-smoke-master-key',
      MCP_JWT_KEY: JWT_KEY,
      MCP_TRANSPORT: 'http',
      MCP_HTTP_PORT: String(port),
      MCP_PUBLIC_URL: publicUrl,
      MCP_OWNER_EMAILS: 'owner@x.example',
    });

    child = spawn(process.execPath, ['--import', 'tsx', srcIndex], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server never listened; stderr so far:\n${stderr}`)), 45_000);
      child!.stderr!.on('data', (c: Buffer) => {
        stderr += c.toString();
        if (stderr.includes('listening')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child!.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited early (${code}); stderr:\n${stderr}`));
      });
    });

    // 1. /health: status + no secrets
    const health = await request(port, 'GET', '/health');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.text)).toMatchObject({ status: 'ok', transport: 'http', ownerConfigured: true });

    // 2. PRM + AS metadata derive from MCP_PUBLIC_URL exactly
    const prm = await request(port, 'GET', '/.well-known/oauth-protected-resource');
    expect(prm.status).toBe(200);
    expect(JSON.parse(prm.text)).toMatchObject({ resource: `${publicUrl}/mcp`, authorization_servers: [publicUrl] });
    const asMeta = await request(port, 'GET', '/.well-known/oauth-authorization-server');
    expect(asMeta.status).toBe(200);
    expect(JSON.parse(asMeta.text)).toMatchObject({ issuer: publicUrl, token_endpoint: `${publicUrl}/token` });

    // 3. unauthenticated /mcp: 401 + resource metadata pointer
    const unauth = await request(port, 'POST', '/mcp', {
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 's', version: '0' } } }),
    });
    expect(unauth.status).toBe(401);
    expect(String(unauth.headers['www-authenticate'])).toContain('resource_metadata');

    // 4. a bearer signed with the SAME provisioned MCP_JWT_KEY is accepted:
    //    the full authenticate -> req.auth -> dispatch chain, no Google leg
    const token = await signAccessToken({ base: publicUrl, secret: jwtSecretFrom(JWT_KEY), iat: Math.floor(Date.now() / 1000), sub: 'owner' });
    const init = await request(port, 'POST', '/mcp', {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 's', version: '0' } } }),
    });
    expect(init.status).toBe(200);
    expect(JSON.parse(init.text).result.serverInfo.name).toBe('mcp-google-multi');

    // 5. clientless /authorize mints a signed state and 302s toward Google
    //    (URL built, never fetched)
    const authz = await request(port, 'GET', '/authorize?flow=alias_reauth&alias=test');
    expect(authz.status).toBe(302);
    const loc = String(authz.headers.location);
    expect(loc).toContain('accounts.google.com');
    expect(loc).toContain('state=');

    // 6. /token rejects garbage without touching the network
    const badGrant = await request(port, 'POST', '/token', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'never-issued' }).toString(),
    });
    expect(badGrant.status).toBe(400);
    expect(JSON.parse(badGrant.text).error).toBe('invalid_grant');
  });
});
