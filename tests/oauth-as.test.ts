import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveHttpConfig } from '../src/http-config.js';
import { HttpTransportHost } from '../src/http-transport.js';
import { buildAuthServer, redirectAllowed, DCR_MAX_CLIENTS, DCR_MAX_REDIRECT_URIS, type AuthServerDeps } from '../src/oauth-as.js';
import { jwtSecretFrom } from '../src/mcp-token.js';
import { SsrfBlockedError } from '../src/ssrf-guard.js';

const BASE = 'https://mcp.test';
const CLIENT_ID = 'https://claude.ai/oauth/mcp-client';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const secret = jwtSecretFrom('an-hs256-test-key');

const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');

let tmp: string;
const hosts: HttpTransportHost[] = [];
const written: Record<string, unknown> = {};

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'gm-as-'));
});
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(written)) delete written[k];
});

async function start(depOverrides: Partial<AuthServerDeps> = {}): Promise<number> {
  const cfg = { ...resolveHttpConfig({ MCP_TRANSPORT: 'http', MCP_PUBLIC_URL: BASE }), port: 0 };
  const deps: AuthServerDeps = {
    fetchCimd: async (cid) => {
      if (cid === CLIENT_ID) return { client_id: cid, redirect_uris: [REDIRECT] };
      throw new SsrfBlockedError('blocked or unknown client');
    },
    buildGoogleAuthUrl: ({ state }) => `https://google.test/auth?state=${encodeURIComponent(state)}`,
    exchangeCode: async (code) => ({
      tokens: { refresh_token: 'g-rt', access_token: 'g-at' },
      email: code === 'owner-code' ? 'owner@x.example' : code === 'work-code' ? 'work@x.example' : 'stranger@x.example',
    }),
    writeToken: (alias, tokens) => {
      written[alias] = tokens;
    },
    aliasEmail: (a) => (a === 'work' ? 'work@x.example' : undefined),
    now: () => Date.now(),
    ...depOverrides,
  };
  const as = buildAuthServer(
    { base: BASE, resourceUri: `${BASE}/mcp`, secret, ownerEmails: ['owner@x.example'], cimdIssuers: ['claude.ai'], masterKey: 'mk', refreshStorePath: path.join(tmp, 'mcp-tokens.enc') },
    deps,
  );
  const server = new McpServer({ name: 'as-test', version: '0' });
  server.registerTool('ping', { description: 'p', inputSchema: {} }, async () => ({ content: [{ type: 'text' as const, text: 'pong' }] }));
  const host = new HttpTransportHost({ server, config: cfg, version: '0', ownerConfigured: true, authenticate: as.authenticate, routes: as.routes });
  await host.start();
  hosts.push(host);
  return host.address()!.port;
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}
function req(port: number, method: string, urlPath: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = opts.body !== undefined ? Buffer.from(opts.body) : undefined;
    const r = http.request(
      { hostname: '127.0.0.1', port, method, path: urlPath, headers: { host: 'mcp.test', ...(data ? { 'content-length': String(data.length) } : {}), ...opts.headers } },
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

function stateFrom(location: string): string {
  return new URL(location).searchParams.get('state') ?? '';
}
const authorizeQuery = (over: Record<string, string> = {}) =>
  new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', resource: `${BASE}/mcp`, state: 'client-xyz', ...over }).toString();
const form = (o: Record<string, string>) => ({ headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });

describe('redirectAllowed (C6)', () => {
  it('exact match, fixed claude.ai, and port-agnostic loopback', () => {
    expect(redirectAllowed(REDIRECT, [])).toBe(true); // fixed callback always allowed
    expect(redirectAllowed('https://claude.ai/cb', ['https://claude.ai/cb'])).toBe(true);
    expect(redirectAllowed('http://localhost:3118/callback', ['http://localhost/callback'])).toBe(true); // random port
    expect(redirectAllowed('http://127.0.0.1:5000/callback', ['http://localhost/callback'])).toBe(true); // loopback equiv
    expect(redirectAllowed('https://evil.example/cb', ['https://claude.ai/cb'])).toBe(false);
    expect(redirectAllowed('http://localhost:3118/other', ['http://localhost/callback'])).toBe(false); // path differs
    // #1: a "127." prefix must NOT masquerade as loopback
    expect(redirectAllowed('http://127.evil.com/callback', ['http://localhost/callback'])).toBe(false);
    expect(redirectAllowed('http://127.0.0.1.evil.com/callback', ['http://127.0.0.1/callback'])).toBe(false);
  });
});

describe('discovery metadata', () => {
  it('serves PRM and AS metadata with S256 and no jwks_uri', async () => {
    const port = await start();
    const prm = JSON.parse((await req(port, 'GET', '/.well-known/oauth-protected-resource')).text);
    expect(prm.resource).toBe(`${BASE}/mcp`);
    expect(prm.authorization_servers).toEqual([BASE]);
    const as = JSON.parse((await req(port, 'GET', '/.well-known/oauth-authorization-server')).text);
    expect(as.issuer).toBe(BASE);
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.jwks_uri).toBeUndefined();
    expect(as.client_id_metadata_document_supported).toBe(true);
  });
});

describe('happy path (legs A + B)', () => {
  it('authorize -> callback(owner) -> token -> /mcp -> refresh', async () => {
    const port = await start();
    // /authorize -> 302 to Google with a signed state
    const authz = await req(port, 'GET', `/authorize?${authorizeQuery()}`);
    expect(authz.status).toBe(302);
    const state = stateFrom(authz.headers.location as string);
    expect(state).toBeTruthy();
    // /callback owner_gate -> 302 back to client with a code + iss
    const cb = await req(port, 'GET', `/callback?code=owner-code&state=${encodeURIComponent(state)}`);
    expect(cb.status).toBe(302);
    const back = new URL(cb.headers.location as string);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('iss')).toBe(BASE);
    expect(back.searchParams.get('state')).toBe('client-xyz');
    const code = back.searchParams.get('code')!;
    expect(code).toBeTruthy();
    // /token authorization_code -> access + refresh
    const tok = JSON.parse((await req(port, 'POST', '/token', form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${BASE}/mcp` }))).text);
    expect(tok.access_token).toBeTruthy();
    expect(tok.refresh_token).toBeTruthy();
    // POST /mcp with the Bearer -> initialize works
    const init = await req(port, 'POST', '/mcp', {
      headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } } }),
    });
    expect(init.status).toBe(200);
    expect(JSON.parse(init.text).result.serverInfo.name).toBe('as-test');
    // refresh -> a rotated token
    const ref = JSON.parse((await req(port, 'POST', '/token', form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token }))).text);
    expect(ref.access_token).toBeTruthy();
    expect(ref.refresh_token).not.toBe(tok.refresh_token);
  });
});

describe('negative paths (one per §5.12 MUST)', () => {
  it('CIMD fetch fail / unknown issuer -> 400 invalid_client (SSRF-blocked)', async () => {
    const port = await start();
    const r = await req(port, 'GET', `/authorize?${authorizeQuery({ client_id: 'https://evil.example/c' })}`);
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text).error).toBe('invalid_client');
  });

  it('redirect_uri mismatch -> 400 error page, NOT redirected (open-redirect defense)', async () => {
    const port = await start();
    const r = await req(port, 'GET', `/authorize?${authorizeQuery({ redirect_uri: 'https://evil.example/cb' })}`);
    expect(r.status).toBe(400);
    expect(r.headers.location).toBeUndefined();
    expect(r.text).toContain('E_REDIRECT_URI_MISMATCH');
  });

  it('missing PKCE S256 -> 400', async () => {
    const port = await start();
    const r = await req(port, 'GET', `/authorize?${authorizeQuery({ code_challenge: '', code_challenge_method: '' })}`);
    expect(r.status).toBe(400);
  });

  it('resource mismatch -> 400', async () => {
    const port = await start();
    const r = await req(port, 'GET', `/authorize?${authorizeQuery({ resource: 'https://mcp.test/wrong' })}`);
    expect(r.status).toBe(400);
  });

  it('tampered state -> 400 E_STATE_INVALID', async () => {
    const port = await start();
    const authz = await req(port, 'GET', `/authorize?${authorizeQuery()}`);
    const state = stateFrom(authz.headers.location as string);
    const r = await req(port, 'GET', `/callback?code=owner-code&state=${encodeURIComponent(state.slice(0, -2) + 'xx')}`);
    expect(r.status).toBe(400);
    expect(r.text).toContain('E_STATE_INVALID');
  });

  it('replayed state -> 400 (single-use)', async () => {
    const port = await start();
    const authz = await req(port, 'GET', `/authorize?${authorizeQuery()}`);
    const state = stateFrom(authz.headers.location as string);
    await req(port, 'GET', `/callback?code=owner-code&state=${encodeURIComponent(state)}`);
    const replay = await req(port, 'GET', `/callback?code=owner-code&state=${encodeURIComponent(state)}`);
    expect(replay.status).toBe(400);
    expect(replay.text).toContain('E_STATE_INVALID');
  });

  it('non-owner email -> 302 access_denied with iss (not a token)', async () => {
    const port = await start();
    const authz = await req(port, 'GET', `/authorize?${authorizeQuery()}`);
    const state = stateFrom(authz.headers.location as string);
    const r = await req(port, 'GET', `/callback?code=stranger-code&state=${encodeURIComponent(state)}`);
    expect(r.status).toBe(302);
    const back = new URL(r.headers.location as string);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('iss')).toBe(BASE);
    expect(back.searchParams.get('code')).toBeNull();
  });

  async function getCode(port: number): Promise<string> {
    const authz = await req(port, 'GET', `/authorize?${authorizeQuery()}`);
    const state = stateFrom(authz.headers.location as string);
    const cb = await req(port, 'GET', `/callback?code=owner-code&state=${encodeURIComponent(state)}`);
    return new URL(cb.headers.location as string).searchParams.get('code')!;
  }

  it('PKCE verifier mismatch at /token -> invalid_grant', async () => {
    const port = await start();
    const code = await getCode(port);
    const r = await req(port, 'POST', '/token', form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: 'wrong-verifier' }));
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text).error).toBe('invalid_grant');
  });

  it('replayed authorization code -> invalid_grant', async () => {
    const port = await start();
    const code = await getCode(port);
    await req(port, 'POST', '/token', form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }));
    const again = await req(port, 'POST', '/token', form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }));
    expect(again.status).toBe(400);
    expect(JSON.parse(again.text).error).toBe('invalid_grant');
  });

  it('reusing a rotated-away refresh token -> invalid_grant', async () => {
    const port = await start();
    const code = await getCode(port);
    const tok = JSON.parse((await req(port, 'POST', '/token', form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }))).text);
    await req(port, 'POST', '/token', form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token }));
    const reuse = await req(port, 'POST', '/token', form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token }));
    expect(reuse.status).toBe(400);
    expect(JSON.parse(reuse.text).error).toBe('invalid_grant');
  });

  it('/mcp without a bearer -> 401 + WWW-Authenticate', async () => {
    const port = await start();
    const r = await req(port, 'POST', '/mcp', { headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(r.status).toBe(401);
    expect(r.headers['www-authenticate']).toContain('resource_metadata');
  });

  it('/mcp with a garbage bearer -> 401', async () => {
    const port = await start();
    const r = await req(port, 'POST', '/mcp', { headers: { authorization: 'Bearer not.a.jwt', accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(401);
  });

  it('alias_reauth writes the alias tokens when the Google identity matches', async () => {
    const port = await start();
    const authz = await req(port, 'GET', `/authorize?${authorizeQuery({ flow: 'alias_reauth', alias: 'work' })}`);
    const state = stateFrom(authz.headers.location as string);
    const cb = await req(port, 'GET', `/callback?code=work-code&state=${encodeURIComponent(state)}`);
    expect(cb.status).toBe(200);
    expect(written.work).toEqual({ refresh_token: 'g-rt', access_token: 'g-at' });
  });

  it('alias_reauth REFUSES a mismatched Google identity (no token injection, #2)', async () => {
    const port = await start();
    const authz = await req(port, 'GET', `/authorize?${authorizeQuery({ flow: 'alias_reauth', alias: 'work' })}`);
    const state = stateFrom(authz.headers.location as string);
    // attacker logs in with their own account (stranger@x.example != work@x.example)
    const cb = await req(port, 'GET', `/callback?code=stranger-code&state=${encodeURIComponent(state)}`);
    expect(cb.status).toBe(403);
    expect(written.work).toBeUndefined();
  });

  it('a DCR-registered client gets a consent interstitial, then proceeds on approval (#3)', async () => {
    const port = await start();
    const reg = JSON.parse((await req(port, 'POST', '/register', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://attacker.example/cb'] }) })).text);
    const dcrId = reg.client_id as string;
    const authz = await req(port, 'GET', `/authorize?${authorizeQuery({ client_id: dcrId, redirect_uri: 'https://attacker.example/cb' })}`);
    // NOT an immediate redirect to Google — an approval page instead
    expect(authz.status).toBe(200);
    expect(authz.headers['content-type']).toContain('text/html');
    expect(authz.text).toContain('attacker.example');
    expect(authz.text).toContain('name="pending"');
    // extract the pending token and approve
    const pending = authz.text.match(/name="pending" value="([^"]+)"/)![1];
    const approved = await req(port, 'POST', '/authorize', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ pending }).toString() });
    expect(approved.status).toBe(302);
    expect(new URL(approved.headers.location as string).searchParams.get('state')).toBeTruthy();
  });

  it('clientless alias_reauth link (BV-1 in-call re-auth) redirects to Google with no client leg', async () => {
    const port = await start();
    const r = await req(port, 'GET', `/authorize?flow=alias_reauth&alias=work`);
    expect(r.status).toBe(302);
    expect(new URL(r.headers.location as string).searchParams.get('state')).toBeTruthy();
  });

  it('clientless alias_reauth for an unknown alias -> 400', async () => {
    const port = await start();
    const r = await req(port, 'GET', `/authorize?flow=alias_reauth&alias=nope`);
    expect(r.status).toBe(400);
  });

  it('a present-but-invalid Origin on an AS route -> 403 (front guard)', async () => {
    const port = await start();
    const r = await req(port, 'GET', '/.well-known/oauth-authorization-server', { headers: { origin: 'https://evil.example' } });
    expect(r.status).toBe(403);
  });
});

describe('DCR /register bounds (unbounded-store DoS guard)', () => {
  it('rejects too many redirect_uris', async () => {
    const port = await start();
    const uris = Array.from({ length: DCR_MAX_REDIRECT_URIS + 1 }, (_, i) => `https://c.example/cb${i}`);
    const r = await req(port, 'POST', '/register', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: uris }) });
    expect(r.status).toBe(400);
  });

  it('rejects an oversized redirect_uri', async () => {
    const port = await start();
    const big = `https://c.example/${'a'.repeat(3000)}`;
    const r = await req(port, 'POST', '/register', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [big] }) });
    expect(r.status).toBe(400);
  });

  it('FIFO-evicts the oldest registration once at capacity (store stays bounded)', async () => {
    const registeredClients = new Map<string, { redirect_uris: string[] }>();
    for (let i = 0; i < DCR_MAX_CLIENTS; i++) registeredClients.set(`seed-${i}`, { redirect_uris: ['https://s.example/cb'] });
    const port = await start({ registeredClients });
    const reg = await req(port, 'POST', '/register', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://new.example/cb'] }) });
    expect(reg.status).toBe(201);
    const newId = JSON.parse(reg.text).client_id as string;
    expect(registeredClients.size).toBe(DCR_MAX_CLIENTS); // did not grow past the cap
    expect(registeredClients.has('seed-0')).toBe(false); // oldest evicted
    expect(registeredClients.has(newId)).toBe(true); // newest present
  });
});
