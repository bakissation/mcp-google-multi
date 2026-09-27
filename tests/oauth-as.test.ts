import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { rmSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { McpServer } from "@modelcontextprotocol/server";
import { resolveHttpConfig } from '../src/http-config.js';
import { HttpTransportHost } from '../src/http-transport.js';
import { buildAuthServer, redirectAllowed, verifiedEmailFromIdToken, verifiedIdentityFromIdToken, DCR_MAX_CLIENTS, DCR_MAX_REDIRECT_URIS, type AuthServer, type AuthServerDeps } from '../src/oauth-as.js';
import { jwtSecretFrom, signAccessToken, signPending, signReauthLink, verifyAccessToken } from '../src/mcp-token.js';
import { SsrfBlockedError } from '../src/ssrf-guard.js';
import { z } from "zod";

const BASE = 'https://mcp.test';
const CLIENT_ID = 'https://claude.ai/oauth/mcp-client';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const secret = jwtSecretFrom('an-hs256-test-key');

const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');

let tmp: string;
const hosts: HttpTransportHost[] = [];
const written: Record<string, unknown> = {};

/** A browser's cookies, keyed by name. Requests use `browser` unless given another jar. */
type Jar = Map<string, string>;
let browser: Jar = new Map();

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'gm-as-'));
  browser = new Map();
});
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(written)) delete written[k];
});

let currentAs: AuthServer | undefined;
/** Path + query of the owner's signed re-auth link from the last start(). */
const reauthPath = (alias: string) => {
  const u = new URL(currentAs!.reauthLink(alias));
  return `${u.pathname}${u.search}`;
};

async function start(depOverrides: Partial<AuthServerDeps> = {}, base = BASE): Promise<number> {
  const cfg = { ...resolveHttpConfig({ MCP_TRANSPORT: 'http', MCP_PUBLIC_URL: base }), port: 0 };
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
    { base, resourceUri: `${base}/mcp`, secret, ownerEmails: ['owner@x.example'], cimdIssuers: ['claude.ai'], masterKey: 'mk', refreshStorePath: path.join(tmp, 'mcp-tokens.enc') },
    deps,
  );
  currentAs = as;
  const server = new McpServer({ name: 'as-test', version: '0' });
  server.registerTool('ping', { description: 'p', inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text' as const, text: 'pong' }] }));
  const host = new HttpTransportHost({ server, config: cfg, version: '0', ownerConfigured: true, authenticate: as.authenticate, routes: as.routes, log: deps.log });
  await host.start();
  hosts.push(host);
  return host.address()!.port;
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}
function storeCookies(jar: Jar, lines: string[] | undefined): void {
  for (const line of lines ?? []) {
    const [pair, ...attrs] = line.split(';');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i).trim();
    if (attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))) jar.delete(name);
    else jar.set(name, pair.slice(i + 1).trim());
  }
}
function req(port: number, method: string, urlPath: string, opts: { headers?: Record<string, string>; body?: string; jar?: Jar } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = opts.body !== undefined ? Buffer.from(opts.body) : undefined;
    const jar = opts.jar ?? browser;
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const r = http.request(
      { hostname: '127.0.0.1', port, method, path: urlPath, headers: { host: 'mcp.test', ...(cookie ? { cookie } : {}), ...(data ? { 'content-length': String(data.length) } : {}), ...opts.headers } },
      (res) => {
        storeCookies(jar, res.headers['set-cookie']);
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

describe('authenticate threads verified claims (S1.4)', () => {
  const buildAs = () =>
    buildAuthServer(
      { base: BASE, resourceUri: `${BASE}/mcp`, secret, ownerEmails: ['owner@x.example'], cimdIssuers: ['claude.ai'], masterKey: 'mk', refreshStorePath: path.join(tmp, 'mcp-tokens.enc') },
      {
        fetchCimd: async () => {
          throw new SsrfBlockedError('unused');
        },
        buildGoogleAuthUrl: () => 'https://google.test/auth',
        exchangeCode: async () => ({ tokens: {}, email: 'unused@x.example' }),
        now: () => Date.now(),
      },
    );

  it('returns the token sub on success instead of discarding the claims', async () => {
    const as = buildAs();
    const token = await signAccessToken({ base: BASE, secret, iat: Math.floor(Date.now() / 1000), sub: 'tenant-7' });
    const out = await as.authenticate({ headers: { authorization: `Bearer ${token}` } } as never);
    expect(out).toEqual({ ok: true, sub: 'tenant-7' });
  });

  it('still rejects an invalid token with 401 (no sub leaks on failure)', async () => {
    const as = buildAs();
    const out = await as.authenticate({ headers: { authorization: 'Bearer not-a-token' } } as never);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(401);
  });
});

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

describe('success-path observability (logs completions, not just failures)', () => {
  it('logs /callback owner_gate, /token (both grants), and the /mcp dispatch — no PII', async () => {
    const logs: string[] = [];
    const port = await start({ log: (l) => logs.push(l) });
    const state = stateFrom((await req(port, 'GET', `/authorize?${authorizeQuery()}`)).headers.location as string);
    const cb = await req(port, 'GET', `/callback?code=owner-code&state=${encodeURIComponent(state)}`);
    const code = new URL(cb.headers.location as string).searchParams.get('code')!;
    const tok = JSON.parse((await req(port, 'POST', '/token', form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${BASE}/mcp` }))).text);
    await req(port, 'POST', '/mcp', {
      headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } } }),
    });
    await req(port, 'POST', '/token', form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token }));

    expect(logs).toContain('callback ok flow=owner_gate');
    expect(logs).toContain('token issued grant=authorization_code');
    expect(logs).toContain('token issued grant=refresh_token');
    expect(logs).toContain('200 /mcp method=initialize');
    // never leak the owner email, Google tokens, or the minted access/refresh values
    expect(logs.join('\n')).not.toMatch(/owner@x|g-rt|g-at|access_token|Bearer/);
  });

  it('logs the /callback alias_reauth completion by alias (no email)', async () => {
    const logs: string[] = [];
    const port = await start({ log: (l) => logs.push(l) });
    const state = stateFrom((await req(port, 'GET', reauthPath('work'))).headers.location as string);
    await req(port, 'GET', `/callback?code=work-code&state=${encodeURIComponent(state)}`);
    expect(logs).toContain('callback ok flow=alias_reauth alias=work');
    expect(logs.join('\n')).not.toMatch(/work@x\.example/);
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

  it('a refresh token naming an inherited object key -> invalid_grant, no token minted', async () => {
    const port = await start();
    for (const refresh_token of ['constructor', '__proto__', 'toString']) {
      const r = await req(port, 'POST', '/token', form({ grant_type: 'refresh_token', refresh_token }));
      expect(r.status).toBe(400);
      const body = JSON.parse(r.text);
      expect(body.error).toBe('invalid_grant');
      expect(body.access_token).toBeUndefined();
    }
    expect(existsSync(path.join(tmp, 'mcp-tokens.enc'))).toBe(false);
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
    const authz = await req(port, 'GET', reauthPath('work'));
    const state = stateFrom(authz.headers.location as string);
    const cb = await req(port, 'GET', `/callback?code=work-code&state=${encodeURIComponent(state)}`);
    expect(cb.status).toBe(200);
    expect(written.work).toEqual({ refresh_token: 'g-rt', access_token: 'g-at' });
  });

  it('alias_reauth keeps the stored token when Google returns no refresh token', async () => {
    const logs: string[] = [];
    const port = await start({
      exchangeCode: async () => ({ tokens: { access_token: 'short-lived' }, email: 'work@x.example' }),
      log: (l) => logs.push(l),
    });
    const authz = await req(port, 'GET', reauthPath('work'));
    const state = stateFrom(authz.headers.location as string);
    const cb = await req(port, 'GET', `/callback?code=work-code&state=${encodeURIComponent(state)}`);
    expect(cb.status).toBe(400);
    expect(cb.text).toContain('E_REAUTH_INCOMPLETE');
    expect(written.work).toBeUndefined();
    expect(logs).toContain('alias_reauth for "work" returned no refresh token; stored token kept');
  });

  it('alias_reauth REFUSES a mismatched Google identity (no token injection, #2)', async () => {
    const port = await start();
    const authz = await req(port, 'GET', reauthPath('work'));
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
    const r = await req(port, 'GET', reauthPath('work'));
    expect(r.status).toBe(302);
    expect(new URL(r.headers.location as string).searchParams.get('state')).toBeTruthy();
  });

  // The link needs no authentication, so an unsigned request must learn
  // nothing: the same 400 for an unsigned, forged, expired or unknown alias.
  it('clientless alias_reauth refuses every link the server did not sign, alike', async () => {
    const port = await start();
    const known = new URL(currentAs!.reauthLink('work'));
    const forged = new URL(known);
    forged.searchParams.set('alias', 'other');
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = `/authorize?flow=alias_reauth&${signReauthLink(BASE, secret, 'work', nowSec - 7200)}`;
    const answers = await Promise.all(
      ['/authorize?flow=alias_reauth&alias=work', '/authorize?flow=alias_reauth&alias=nope', `${forged.pathname}${forged.search}`, expired, reauthPath('nope')].map((p) => req(port, 'GET', p)),
    );
    for (const r of answers) {
      expect(r.status).toBe(400);
      expect(r.text).toBe('E_STATE_INVALID: this re-auth link is invalid or expired; ask the server for a fresh one');
      expect(r.headers.location).toBeUndefined();
    }
  });

  // alpha.57 signed a DCR pending with flow=alias_reauth; one still inside its
  // TTL at upgrade must not start the old unauthenticated re-auth.
  it('POST /authorize refuses a pending that is not an owner sign-in', async () => {
    const asked: string[] = [];
    const port = await start({
      buildGoogleAuthUrl: ({ flow, state }) => {
        asked.push(flow);
        return `https://google.test/auth?state=${encodeURIComponent(state)}`;
      },
    });
    const old = await signPending(
      { flow: 'alias_reauth', client_id: 'dcr', redirect_uri: 'https://x.example/cb', code_challenge: challenge, resource: `${BASE}/mcp`, alias: 'work' },
      BASE,
      secret,
      Math.floor(Date.now() / 1000),
    );
    const r = await req(port, 'POST', '/authorize', form({ pending: old }));
    expect(r.status).toBe(400);
    expect(r.text).toContain('E_STATE_INVALID');
    expect(asked).toEqual([]);
    await expect(currentAs!.mintFlowState({ flow: 'alias_reauth' as never, alias: 'work' })).rejects.toThrow('alias_add only');
  });

  it('a signed re-auth link survives a prefetch: it is not single-use', async () => {
    const port = await start();
    const link = reauthPath('work');
    expect((await req(port, 'GET', link)).status).toBe(302);
    expect((await req(port, 'GET', link)).status).toBe(302);
  });

  it('a client leg can no longer start a re-auth or learn an alias scope set', async () => {
    const asked: Array<{ flow: string; alias?: string }> = [];
    const port = await start({
      buildGoogleAuthUrl: ({ flow, alias, state }) => {
        asked.push({ flow, alias });
        return `https://google.test/auth?state=${encodeURIComponent(state)}`;
      },
    });
    const r = await req(port, 'GET', `/authorize?${authorizeQuery({ flow: 'alias_reauth', alias: 'work' })}`);
    expect(r.status).toBe(302);
    expect(asked).toEqual([{ flow: 'owner_gate', alias: undefined }]);
    // completing it is an owner sign-in, never a token write for the alias
    const cb = await req(port, 'GET', `/callback?code=work-code&state=${encodeURIComponent(stateFrom(r.headers.location as string))}`);
    expect(cb.status).not.toBe(200);
    expect(written.work).toBeUndefined();
  });

  it('alias_reauth names the scopes Google left out when there is no stored token to keep', async () => {
    const port = await start({
      exchangeCode: async () => ({ tokens: { refresh_token: 'g-rt', access_token: 'g-at', scope: 'openid email' }, email: 'work@x.example' }),
      missingScopes: (alias, granted) => (alias === 'work' && granted === 'openid email' ? ['https://www.googleapis.com/auth/drive'] : []),
      hasToken: () => false,
    });
    const authz = await req(port, 'GET', reauthPath('work'));
    const cb = await req(port, 'GET', `/callback?code=work-code&state=${encodeURIComponent(stateFrom(authz.headers.location as string))}`);
    expect(cb.status).toBe(200);
    expect(cb.text).toContain('Google did not grant 1 requested scope(s): <code>https://www.googleapis.com/auth/drive</code>');
    expect(written.work).toMatchObject({ scope: 'openid email' });
  });

  // The link is reusable and the Google URL's scope is not signed, so a
  // narrower grant must not replace a working token.
  it('alias_reauth keeps a stored token when the new grant is narrower', async () => {
    const logs: string[] = [];
    const port = await start({
      exchangeCode: async () => ({ tokens: { refresh_token: 'narrow-rt', access_token: 'narrow-at', scope: 'openid email' }, email: 'work@x.example' }),
      missingScopes: () => ['https://www.googleapis.com/auth/drive'],
      hasToken: (alias) => alias === 'work',
      log: (l) => logs.push(l),
    });
    const authz = await req(port, 'GET', reauthPath('work'));
    const cb = await req(port, 'GET', `/callback?code=work-code&state=${encodeURIComponent(stateFrom(authz.headers.location as string))}`);
    expect(cb.status).toBe(400);
    expect(cb.text).toContain('E_SCOPE_NOT_GRANTED');
    expect(cb.text).toContain('was kept');
    expect(written.work).toBeUndefined();
    expect(logs).toContain('alias_reauth for "work" granted 1 fewer scope(s); stored token kept');
  });

  it('a present-but-invalid Origin on an AS route -> 403 (front guard)', async () => {
    const port = await start();
    const r = await req(port, 'GET', '/.well-known/oauth-authorization-server', { headers: { origin: 'https://evil.example' } });
    expect(r.status).toBe(403);
  });
});

describe('owner_gate Google leg is bound to the browser that started it (H4 F1)', () => {
  const ATTACKER_CB = 'https://attacker.example/cb';
  const bindCookies = (jar: Jar) => [...jar.keys()].filter((k) => k.includes('mgm-og-'));

  /** Deps whose exchange and subject resolution record every call. */
  function spied(extra: Partial<AuthServerDeps> = {}) {
    const calls = { exchange: 0, resolve: 0 };
    const logs: string[] = [];
    const deps: Partial<AuthServerDeps> = {
      exchangeCode: async () => {
        calls.exchange++;
        return { tokens: {}, email: 'owner@x.example' };
      },
      resolveSubject: () => {
        calls.resolve++;
        return { sub: 'owner' };
      },
      log: (l) => logs.push(l),
      ...extra,
    };
    return { calls, logs, deps };
  }

  /** A DCR client registered and approved from `jar`; returns the Google state. */
  async function dcrGoogleState(port: number, jar: Jar): Promise<{ state: string; approved: Res; interstitial: Res }> {
    const reg = JSON.parse((await req(port, 'POST', '/register', { jar, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [ATTACKER_CB] }) })).text);
    const interstitial = await req(port, 'GET', `/authorize?${authorizeQuery({ client_id: reg.client_id, redirect_uri: ATTACKER_CB })}`, { jar });
    const pending = interstitial.text.match(/name="pending" value="([^"]+)"/)![1];
    const approved = await req(port, 'POST', '/authorize', { jar, ...form({ pending }) });
    expect(approved.status).toBe(302);
    return { state: stateFrom(approved.headers.location as string), approved, interstitial };
  }

  it('a forwarded Google URL completed in another browser is refused 400: no code, no exchange, no subject lookup', async () => {
    const { calls, logs, deps } = spied();
    const port = await start(deps);
    const attacker: Jar = new Map();
    const victim: Jar = new Map();
    const { state } = await dcrGoogleState(port, attacker);
    const cb = await req(port, 'GET', `/callback?code=owner-code&state=${encodeURIComponent(state)}`, { jar: victim });
    expect(cb.status).toBe(400);
    expect(cb.headers.location).toBeUndefined();
    expect(cb.text).not.toContain('attacker.example');
    expect(cb.text).not.toContain('code=');
    expect(cb.text).toContain('E_BROWSER_MISMATCH');
    expect(calls).toEqual({ exchange: 0, resolve: 0 });
    const refused = logs.filter((l) => l.startsWith('callback refused'));
    expect(refused).toEqual(['callback refused flow=owner_gate: browser binding missing']);
    const cookieValue = attacker.get(bindCookies(attacker)[0])!;
    expect(logs.join('\n')).not.toContain(cookieValue);
    expect(logs.join('\n')).not.toContain(state);
    // the refused state is spent: the starting browser cannot replay the victim's callback
    const replay = await req(port, 'GET', `/callback?code=owner-code&state=${encodeURIComponent(state)}`, { jar: attacker });
    expect(replay.status).toBe(400);
    expect(replay.headers.location).toBeUndefined();
    expect(calls).toEqual({ exchange: 0, resolve: 0 });
  });

  it('the same browser completes the DCR flow and the binding cookie is cleared', async () => {
    const { calls, deps } = spied();
    const port = await start(deps);
    const jar: Jar = new Map();
    const { state } = await dcrGoogleState(port, jar);
    expect(bindCookies(jar)).toHaveLength(1);
    const cb = await req(port, 'GET', `/callback?code=owner-code&state=${encodeURIComponent(state)}`, { jar });
    expect(cb.status).toBe(302);
    const back = new URL(cb.headers.location as string);
    expect(back.origin + back.pathname).toBe(ATTACKER_CB);
    expect(back.searchParams.get('code')).toBeTruthy();
    expect(calls).toEqual({ exchange: 1, resolve: 1 });
    expect(bindCookies(jar)).toHaveLength(0);
  });

  it('a tampered binding cookie is refused before the exchange', async () => {
    const { calls, logs, deps } = spied();
    const port = await start(deps);
    const jar: Jar = new Map();
    const { state } = await dcrGoogleState(port, jar);
    const [name] = bindCookies(jar);
    const value = jar.get(name)!;
    jar.set(name, (value[0] === 'A' ? 'B' : 'A') + value.slice(1));
    const cb = await req(port, 'GET', `/callback?code=owner-code&state=${encodeURIComponent(state)}`, { jar });
    expect(cb.status).toBe(400);
    expect(cb.headers.location).toBeUndefined();
    expect(cb.text).toContain('E_BROWSER_MISMATCH');
    expect(calls).toEqual({ exchange: 0, resolve: 0 });
    expect(logs).toContain('callback refused flow=owner_gate: browser binding mismatch');
  });

  it("another browser's own binding cookie does not unlock the forwarded state", async () => {
    const { calls, deps } = spied();
    const port = await start(deps);
    const attacker: Jar = new Map();
    const victim: Jar = new Map();
    const { state } = await dcrGoogleState(port, attacker);
    await req(port, 'GET', `/authorize?${authorizeQuery()}`, { jar: victim });
    expect(bindCookies(victim)).toHaveLength(1);
    const cb = await req(port, 'GET', `/callback?code=owner-code&state=${encodeURIComponent(state)}`, { jar: victim });
    expect(cb.status).toBe(400);
    expect(calls.exchange).toBe(0);
  });

  it('two sign-ins started in one browser both complete (one cookie per flow)', async () => {
    const { deps } = spied();
    const port = await start(deps);
    const first = stateFrom((await req(port, 'GET', `/authorize?${authorizeQuery()}`)).headers.location as string);
    const second = stateFrom((await req(port, 'GET', `/authorize?${authorizeQuery()}`)).headers.location as string);
    expect(bindCookies(browser)).toHaveLength(2);
    expect((await req(port, 'GET', `/callback?code=owner-code&state=${encodeURIComponent(first)}`)).status).toBe(302);
    expect((await req(port, 'GET', `/callback?code=owner-code&state=${encodeURIComponent(second)}`)).status).toBe(302);
    expect(bindCookies(browser)).toHaveLength(0);
  });

  it('an https base sets a __Host- cookie (Secure, HttpOnly, Lax, Path=/, the state TTL, no Domain) on both client legs', async () => {
    const port = await start();
    const cimd = await req(port, 'GET', `/authorize?${authorizeQuery()}`);
    const { approved } = await dcrGoogleState(port, new Map());
    for (const r of [cimd, approved]) {
      const lines = r.headers['set-cookie'] ?? [];
      expect(lines).toHaveLength(1);
      const [pair, ...attrs] = lines[0].split(';').map((a) => a.trim());
      expect(pair).toMatch(/^__Host-mgm-og-[A-Za-z0-9_-]+=[A-Za-z0-9_-]{43}$/);
      expect(attrs.map((a) => a.toLowerCase()).sort()).toEqual(['httponly', 'max-age=600', 'path=/', 'samesite=lax', 'secure']);
    }
  });

  it('an http loopback base (the single owner) uses a cookie without Secure and the sign-in completes', async () => {
    const LOOP = 'http://127.0.0.1:3118';
    const port = await start({}, LOOP);
    const host = { host: '127.0.0.1:3118' };
    const q = authorizeQuery({ resource: `${LOOP}/mcp` });
    const authz = await req(port, 'GET', `/authorize?${q}`, { headers: host });
    expect(authz.status).toBe(302);
    const [line] = authz.headers['set-cookie'] ?? [];
    expect(line).toMatch(/^mgm-og-[A-Za-z0-9_-]+=/);
    expect(line.toLowerCase()).not.toContain('secure');
    expect(line.toLowerCase()).toContain('httponly');
    const cb = await req(port, 'GET', `/callback?code=owner-code&state=${encodeURIComponent(stateFrom(authz.headers.location as string))}`, { headers: host });
    expect(cb.status).toBe(302);
    const code = new URL(cb.headers.location as string).searchParams.get('code')!;
    const tok = JSON.parse((await req(port, 'POST', '/token', { headers: { ...host, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${LOOP}/mcp` }).toString() })).text);
    expect((await verifyAccessToken(tok.access_token, LOOP, secret)).sub).toBe('owner');
    expect(bindCookies(browser)).toHaveLength(0);
  });

  it('alias_reauth and alias_add set no binding cookie and complete from a fresh browser', async () => {
    const port = await start({ bindTenantAlias: () => undefined });
    const reauth = await req(port, 'GET', reauthPath('work'));
    expect(reauth.headers['set-cookie']).toBeUndefined();
    const r1 = await req(port, 'GET', `/callback?code=work-code&state=${encodeURIComponent(stateFrom(reauth.headers.location as string))}`, { jar: new Map() });
    expect(r1.status).toBe(200);
    const url = new URL(await currentAs!.mintFlowState({ flow: 'alias_add', alias: 'side', tenantId: 'tenant-a' }));
    const add = await req(port, 'GET', `${url.pathname}${url.search}`);
    expect(add.headers['set-cookie']).toBeUndefined();
    const r2 = await req(port, 'GET', `/callback?code=work-code&state=${encodeURIComponent(stateFrom(add.headers.location as string))}`, { jar: new Map() });
    expect(r2.status).toBe(200);
  });

  it('the DCR consent interstitial refuses to be framed', async () => {
    const port = await start();
    const { interstitial } = await dcrGoogleState(port, new Map());
    expect(interstitial.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(interstitial.headers['x-frame-options']).toBe('DENY');
  });
});

describe('a failed Google code exchange answers a generic page (H4 F12)', () => {
  const detail = 'request to https://oauth2.googleapis.com/token failed, reason: connect ECONNREFUSED 10.9.8.7:3128\nproxy-authorization: Basic c2VjcmV0';

  it('owner_gate and alias_reauth show no exchange detail; the log gets it on one line', async () => {
    const logs: string[] = [];
    const port = await start({
      exchangeCode: async () => {
        throw new Error(detail);
      },
      log: (l) => logs.push(l),
    });
    const owner = stateFrom((await req(port, 'GET', `/authorize?${authorizeQuery()}`)).headers.location as string);
    const reauth = stateFrom((await req(port, 'GET', reauthPath('work'))).headers.location as string);
    for (const [flow, state] of [['owner_gate', owner], ['alias_reauth', reauth]]) {
      const cb = await req(port, 'GET', `/callback?code=owner-code&state=${encodeURIComponent(state)}`);
      expect(cb.status).toBe(400);
      expect(cb.headers.location).toBeUndefined();
      expect(cb.text).toBe('invalid_grant: Google could not complete the sign-in; start again from your app');
      const line = logs.find((l) => l.startsWith(`callback exchange failed flow=${flow}:`));
      expect(line).toContain('ECONNREFUSED 10.9.8.7:3128');
      expect(line).not.toMatch(/[\r\n]/);
    }
    expect(written.work).toBeUndefined();
  });

  it('a non-Error rejection still answers the generic page', async () => {
    const port = await start({ exchangeCode: () => Promise.reject(undefined) });
    const state = stateFrom((await req(port, 'GET', `/authorize?${authorizeQuery()}`)).headers.location as string);
    const cb = await req(port, 'GET', `/callback?code=owner-code&state=${encodeURIComponent(state)}`);
    expect(cb.status).toBe(400);
    expect(cb.text).toBe('invalid_grant: Google could not complete the sign-in; start again from your app');
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

type AuthServerDepsMint = ReturnType<typeof buildAuthServer>['mintFlowState'];

describe('alias_add flow + resolveSubject seam (S1.14)', () => {
  const binds: Record<string, unknown>[] = [];
  afterEach(() => void binds.splice(0));

  async function startMt(configOver: Record<string, unknown> = {}, depOverrides: Partial<AuthServerDeps> = {}) {
    const cfg = { ...resolveHttpConfig({ MCP_TRANSPORT: 'http', MCP_PUBLIC_URL: BASE }), port: 0 };
    const deps: AuthServerDeps = {
      fetchCimd: async (cid) => {
        if (cid === CLIENT_ID) return { client_id: cid, redirect_uris: [REDIRECT] };
        throw new SsrfBlockedError('blocked or unknown client');
      },
      buildGoogleAuthUrl: ({ state }) => `https://google.test/auth?state=${encodeURIComponent(state)}`,
      exchangeCode: async (code) => ({
        tokens: { refresh_token: 'g-rt', access_token: 'g-at' },
        email: code === 'owner-code' ? 'owner@x.example' : 'member@x.example',
      }),
      bindTenantAlias: (b) => void binds.push(b as unknown as Record<string, unknown>),
      now: () => Date.now(),
      ...depOverrides,
    };
    const as = buildAuthServer(
      { base: BASE, resourceUri: `${BASE}/mcp`, secret, ownerEmails: ['owner@x.example'], cimdIssuers: ['claude.ai'], masterKey: 'mk', refreshStorePath: path.join(tmp, 'mcp-tokens.enc'), ...configOver },
      deps,
    );
    const server = new McpServer({ name: 'as-test', version: '0' });
    server.registerTool('ping', { description: 'p', inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text' as const, text: 'pong' }] }));
    const host = new HttpTransportHost({ server, config: cfg, version: '0', ownerConfigured: true, authenticate: as.authenticate, routes: as.routes });
    await host.start();
    hosts.push(host);
    return { port: host.address()!.port, as };
  }

  it('happy path: minted link -> Google -> callback binds under the RIGHT tenant, sibling untouched', async () => {
    const { port, as } = await startMt();
    const url = new URL(await as.mintFlowState({ flow: 'alias_add', alias: 'work', tenantId: 'tenant-a', bundles: ['forms'] }));
    expect(url.pathname).toBe('/authorize');
    expect(url.searchParams.get('flow')).toBe('alias_add');
    const authz = await req(port, 'GET', `${url.pathname}${url.search}`);
    expect(authz.status).toBe(302);
    const googleState = stateFrom(authz.headers.location as string);
    const cb = await req(port, 'GET', `/callback?code=member-code&state=${encodeURIComponent(googleState)}`);
    expect(cb.status).toBe(200);
    expect(cb.text).toContain('Connected "work"');
    expect(binds).toHaveLength(1);
    expect(binds[0]).toMatchObject({ tenantId: 'tenant-a', alias: 'work', email: 'member@x.example', bundles: ['forms'] });
    // exactly one bind, under exactly the minted tenant - no sibling writes
    expect(binds.filter((b) => b.tenantId !== 'tenant-a')).toHaveLength(0);
  });

  it('a tampered tenantId breaks the signature: E_STATE_INVALID, nothing bound', async () => {
    const { port, as } = await startMt();
    const url = new URL(await as.mintFlowState({ flow: 'alias_add', alias: 'work', tenantId: 'tenant-a' }));
    const state = url.searchParams.get('state')!;
    const [h, payload, sig] = state.split('.');
    const flipped = payload.slice(0, -4) + (payload.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const r = await req(port, 'GET', `/authorize?flow=alias_add&state=${encodeURIComponent([h, flipped, sig].join('.'))}`);
    expect(r.status).toBe(400);
    expect(r.text).toContain('E_STATE_INVALID');
    expect(binds).toHaveLength(0);
  });

  it('the minted link is single-use: a second click is refused', async () => {
    const { port, as } = await startMt();
    const url = new URL(await as.mintFlowState({ flow: 'alias_add', alias: 'work', tenantId: 'tenant-a' }));
    const linkPath = `${url.pathname}${url.search}`;
    expect((await req(port, 'GET', linkPath)).status).toBe(302);
    const again = await req(port, 'GET', linkPath);
    expect(again.status).toBe(400);
    expect(again.text).toContain('already used');
  });

  it('callback without a bind seam refuses cleanly (free core stays inert)', async () => {
    const { port, as } = await startMt({}, { bindTenantAlias: undefined });
    const url = new URL(await as.mintFlowState({ flow: 'alias_add', alias: 'work', tenantId: 'tenant-a' }));
    const authz = await req(port, 'GET', `${url.pathname}${url.search}`);
    const cb = await req(port, 'GET', `/callback?code=member-code&state=${encodeURIComponent(stateFrom(authz.headers.location as string))}`);
    expect(cb.status).toBe(500);
    expect(cb.text).toContain('E_ALIAS_ADD_UNAVAILABLE');
  });

  it('legacyAliasReauth:false disables the alias-only clientless branch with 403', async () => {
    const { port } = await startMt({ legacyAliasReauth: false }, { aliasEmail: (a) => (a === 'work' ? 'work@x.example' : undefined) });
    const r = await req(port, 'GET', '/authorize?flow=alias_reauth&alias=work');
    expect(r.status).toBe(403);
    expect(r.text).toContain('E_LEGACY_REAUTH_DISABLED');
  });

  it('resolveSubject threads a non-owner sub end-to-end into access AND refreshed tokens', async () => {
    const { port } = await startMt({}, { resolveSubject: (email) => (email === 'member@x.example' ? { sub: 'tenant-9' } : null) });
    const authz = await req(port, 'GET', `/authorize?${authorizeQuery()}`);
    const state = stateFrom(authz.headers.location as string);
    const cb = await req(port, 'GET', `/callback?code=member-code&state=${encodeURIComponent(state)}`);
    expect(cb.status).toBe(302);
    const code = new URL(cb.headers.location as string).searchParams.get('code')!;
    const tok = JSON.parse((await req(port, 'POST', '/token', form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${BASE}/mcp` }))).text);
    expect((await verifyAccessToken(tok.access_token, BASE, secret)).sub).toBe('tenant-9');
    const ref = JSON.parse((await req(port, 'POST', '/token', form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token }))).text);
    expect((await verifyAccessToken(ref.access_token, BASE, secret)).sub).toBe('tenant-9');
  });

  describe('subjectActive: /token refuses a subject the host no longer serves', () => {
    const subjects = (email: string) => (email === 'member@x.example' ? { sub: 'tenant-9' } : email === 'owner@x.example' ? { sub: 'tenant-8' } : null);
    async function codeFor(port: number, googleCode = 'member-code'): Promise<string> {
      const authz = await req(port, 'GET', `/authorize?${authorizeQuery()}`);
      const cb = await req(port, 'GET', `/callback?code=${googleCode}&state=${encodeURIComponent(stateFrom(authz.headers.location as string))}`);
      expect(cb.status).toBe(302);
      return new URL(cb.headers.location as string).searchParams.get('code')!;
    }
    const redeem = (port: number, code: string) =>
      req(port, 'POST', '/token', form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${BASE}/mcp` }));
    const refreshWith = (port: number, refresh_token: string) => req(port, 'POST', '/token', form({ grant_type: 'refresh_token', refresh_token }));

    it('a code whose subject became inactive before redemption is refused invalid_grant and issues no refresh token', async () => {
      let active = true;
      const asked: string[] = [];
      const { port } = await startMt({}, { resolveSubject: subjects, subjectActive: (sub) => (asked.push(sub), active) });
      const code = await codeFor(port);
      active = false;
      const r = await redeem(port, code);
      expect(r.status).toBe(400);
      expect(JSON.parse(r.text)).toEqual({ error: 'invalid_grant', message: 'the subject is no longer provisioned' });
      expect(asked).toEqual(['tenant-9']);
      expect(existsSync(path.join(tmp, 'mcp-tokens.enc'))).toBe(false);
    });

    it('a refresh token whose subject became inactive is refused invalid_grant, and the family is gone: once subjectActive answers true again, the rotated token is still refused', async () => {
      let active = true;
      const { port } = await startMt({}, { resolveSubject: subjects, subjectActive: (sub) => sub !== 'tenant-9' || active });
      const first = JSON.parse((await redeem(port, await codeFor(port))).text);
      const second = JSON.parse((await redeem(port, await codeFor(port))).text);
      const other = JSON.parse((await redeem(port, await codeFor(port, 'owner-code'))).text);
      const rotated = JSON.parse((await refreshWith(port, first.refresh_token)).text);
      expect(rotated.refresh_token).toBeTruthy();
      active = false;
      const refused = await refreshWith(port, rotated.refresh_token);
      expect(refused.status).toBe(400);
      expect(JSON.parse(refused.text).error).toBe('invalid_grant');
      active = true;
      expect((await refreshWith(port, rotated.refresh_token)).status).toBe(400);
      expect((await refreshWith(port, second.refresh_token)).status).toBe(400);
      const kept = await refreshWith(port, other.refresh_token);
      expect(kept.status).toBe(200);
      expect((await verifyAccessToken(JSON.parse(kept.text).access_token, BASE, secret)).sub).toBe('tenant-8');
    });

    it('a throwing subjectActive answers 503 temporarily_unavailable on both grants, the message does not reach the body, and the presented refresh token still rotates on the next attempt', async () => {
      let broken = false;
      const lines: string[] = [];
      const { port } = await startMt(
        {},
        {
          resolveSubject: subjects,
          log: (l) => lines.push(l),
          subjectActive: () => {
            if (broken) throw new Error('registry /srv/private/tenants.enc unreadable');
            return true;
          },
        },
      );
      const tok = JSON.parse((await redeem(port, await codeFor(port))).text);
      const pendingCode = await codeFor(port);
      broken = true;
      for (const r of [await redeem(port, pendingCode), await refreshWith(port, tok.refresh_token)]) {
        expect(r.status).toBe(503);
        expect(r.headers['retry-after']).toBe('5');
        expect(JSON.parse(r.text).error).toBe('temporarily_unavailable');
        expect(r.text).not.toContain('private');
        expect(r.text).not.toContain('unreadable');
      }
      expect(lines.filter((l) => l.includes('unreadable'))).toHaveLength(2);
      broken = false;
      const ref = await refreshWith(port, tok.refresh_token);
      expect(ref.status).toBe(200);
      expect((await verifyAccessToken(JSON.parse(ref.text).access_token, BASE, secret)).sub).toBe('tenant-9');
      // the code's jti was spent before the check; the client signs in again
      expect(JSON.parse((await redeem(port, pendingCode)).text).message).toBe('authorization code already redeemed');
    });
  });

  async function googleLegState(port: number, as: { mintFlowState: AuthServerDepsMint }, opts: Parameters<AuthServerDepsMint>[0]) {
    const url = new URL(await as.mintFlowState(opts));
    const authz = await req(port, 'GET', `${url.pathname}${url.search}`);
    expect(authz.status).toBe(302);
    return stateFrom(authz.headers.location as string);
  }
  const complete = (port: number, state: string) => req(port, 'GET', `/callback?code=member-code&state=${encodeURIComponent(state)}`);

  it('a returned refusal answers 403 with its slug and message, never the Connected page', async () => {
    const { port, as } = await startMt({}, { bindTenantAlias: () => ({ refused: { slug: 'E_ALIAS_EXISTS', message: 'that name is taken' } }) });
    const cb = await complete(port, await googleLegState(port, as, { flow: 'alias_add', alias: 'work', tenantId: 'tenant-a' }));
    expect(cb.status).toBe(403);
    expect(cb.text).toBe('E_ALIAS_EXISTS: that name is taken');
  });

  it('a refusal slug that is not a bare identifier renders as access_denied', async () => {
    const { port, as } = await startMt({}, { bindTenantAlias: () => ({ refused: { slug: '<script>', message: 'no' } }) });
    const cb = await complete(port, await googleLegState(port, as, { flow: 'alias_add', alias: 'work', tenantId: 'tenant-a' }));
    expect(cb.status).toBe(403);
    expect(cb.text).toBe('access_denied: no');
  });

  it('an async bind that rejects answers 500 E_ALIAS_ADD_FAILED, never 200', async () => {
    const { port, as } = await startMt({}, { bindTenantAlias: async () => { throw new Error('disk full'); } });
    const cb = await complete(port, await googleLegState(port, as, { flow: 'alias_add', alias: 'work', tenantId: 'tenant-a' }));
    expect(cb.status).toBe(500);
    expect(cb.text).toContain('E_ALIAS_ADD_FAILED');
  });

  it('an async bind answers only after it settles', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let settled = false;
    const { port, as } = await startMt({}, { bindTenantAlias: async () => { await gate; settled = true; } });
    const state = await googleLegState(port, as, { flow: 'alias_add', alias: 'work', tenantId: 'tenant-a' });
    let answered = false;
    const pending = complete(port, state).then((r) => { answered = true; return r; });
    await new Promise((r) => setTimeout(r, 50));
    expect(answered).toBe(false);
    release();
    const cb = await pending;
    expect(settled).toBe(true);
    expect(cb.status).toBe(200);
  });

  it('a malformed refusal still answers 403 with a readable message', async () => {
    for (const refused of [{ slug: 'E_X' }, {}, { slug: 'E_Y', message: { a: 1 } }, { slug: 'E_Z', message: Object.create(null) }]) {
      const { port, as } = await startMt({}, { bindTenantAlias: () => ({ refused }) as never });
      const cb = await complete(port, await googleLegState(port, as, { flow: 'alias_add', alias: 'work', tenantId: 'tenant-a' }));
      expect(cb.status, JSON.stringify(refused)).toBe(403);
      expect(cb.text).toMatch(/^[A-Za-z0-9_]+: the account could not be linked$/);
    }
  });

  it('a rejection with no reason, or a thrown null, still answers 500 E_ALIAS_ADD_FAILED', async () => {
    for (const bindTenantAlias of [() => Promise.reject(undefined), async () => { throw null; }, () => { throw undefined; }]) {
      const { port, as } = await startMt({}, { bindTenantAlias: bindTenantAlias as never });
      const cb = await complete(port, await googleLegState(port, as, { flow: 'alias_add', alias: 'work', tenantId: 'tenant-a' }));
      expect(cb.status).toBe(500);
      expect(cb.text).toContain('E_ALIAS_ADD_FAILED');
    }
  });

  it('a thrown bind error still answers 500 E_ALIAS_ADD_FAILED', async () => {
    const { port, as } = await startMt({}, { bindTenantAlias: () => { throw new Error('boom'); } });
    const cb = await complete(port, await googleLegState(port, as, { flow: 'alias_add', alias: 'work', tenantId: 'tenant-a' }));
    expect(cb.status).toBe(500);
    expect(cb.text).toContain('E_ALIAS_ADD_FAILED');
  });

  it('buildGoogleAuthUrl receives the signed bundles for alias_add and none for owner_gate', async () => {
    const seen: { flow: string; bundles?: string[] }[] = [];
    const { port, as } = await startMt({}, {
      buildGoogleAuthUrl: ({ flow, state, bundles }) => {
        seen.push({ flow, bundles });
        return `https://google.test/auth?state=${encodeURIComponent(state)}`;
      },
    });
    await googleLegState(port, as, { flow: 'alias_add', alias: 'work', tenantId: 'tenant-a', bundles: ['forms', 'chat'] });
    await req(port, 'GET', `/authorize?${authorizeQuery()}`);
    expect(seen).toEqual([{ flow: 'alias_add', bundles: ['forms', 'chat'] }, { flow: 'owner_gate', bundles: undefined }]);
  });

  it('the minted nonce survives the /authorize re-sign and reaches the binder', async () => {
    const { port, as } = await startMt();
    const cb = await complete(port, await googleLegState(port, as, { flow: 'alias_add', alias: 'work', tenantId: 'tenant-a', nonce: 'n-123' }));
    expect(cb.status).toBe(200);
    expect(binds[0]).toMatchObject({ tenantId: 'tenant-a', alias: 'work', nonce: 'n-123' });
  });

  it('the alias_add success page escapes the alias', async () => {
    const { port, as } = await startMt();
    const cb = await complete(port, await googleLegState(port, as, { flow: 'alias_add', alias: '<b>x</b>', tenantId: 'tenant-a' }));
    expect(cb.status).toBe(200);
    expect(cb.text).not.toContain('<b>');
    expect(cb.text).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('the default resolveSubject reproduces the owner allowlist exactly (non-owner denied)', async () => {
    const { port } = await startMt();
    const authz = await req(port, 'GET', `/authorize?${authorizeQuery()}`);
    const state = stateFrom(authz.headers.location as string);
    const cb = await req(port, 'GET', `/callback?code=member-code&state=${encodeURIComponent(state)}`);
    expect(cb.status).toBe(302);
    expect(new URL(cb.headers.location as string).searchParams.get('error')).toBe('access_denied');
  });

  const ownerGateCallback = async (port: number) => {
    const authz = await req(port, 'GET', `/authorize?${authorizeQuery()}`);
    return req(port, 'GET', `/callback?code=member-code&state=${encodeURIComponent(stateFrom(authz.headers.location as string))}`);
  };

  it('owner_gate hands resolveSubject the verified Google sub and hd', async () => {
    const seen: unknown[][] = [];
    const { port } = await startMt({}, {
      exchangeCode: async () => ({ tokens: {}, email: 'member@x.example', sub: '1234', hd: 'x.example' }),
      resolveSubject: (...args) => {
        seen.push(args);
        return { sub: 'tenant-a' };
      },
    });
    const cb = await ownerGateCallback(port);
    expect(cb.status).toBe(302);
    expect(new URL(cb.headers.location as string).searchParams.get('code')).toBeTruthy();
    expect(seen).toEqual([['member@x.example', { sub: '1234', hd: 'x.example' }]]);
  });

  it('an exchange without a sub still resolves by email', async () => {
    const seen: unknown[][] = [];
    const { port } = await startMt({}, {
      resolveSubject: (...args) => {
        seen.push(args);
        return null;
      },
    });
    const cb = await ownerGateCallback(port);
    expect(new URL(cb.headers.location as string).searchParams.get('error')).toBe('access_denied');
    expect(seen).toEqual([['member@x.example', { sub: undefined, hd: undefined }]]);
  });

  it('alias_add hands bindTenantAlias the verified sub', async () => {
    const { port, as } = await startMt({}, {
      exchangeCode: async () => ({ tokens: { refresh_token: 'g-rt' }, email: 'member@x.example', sub: '1234', hd: 'x.example' }),
    });
    const cb = await complete(port, await googleLegState(port, as, { flow: 'alias_add', alias: 'work', tenantId: 'tenant-a' }));
    expect(cb.status).toBe(200);
    expect(binds[0]).toMatchObject({ tenantId: 'tenant-a', alias: 'work', email: 'member@x.example', sub: '1234' });
    expect(binds[0]).not.toHaveProperty('hd');
  });
});

describe('verifiedEmailFromIdToken', () => {
  const idToken = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

  it('trusts only email_verified true or "true"', () => {
    expect(verifiedEmailFromIdToken(idToken({ email: 'a@x.example', email_verified: true }))).toBe('a@x.example');
    expect(verifiedEmailFromIdToken(idToken({ email: 'a@x.example', email_verified: 'true' }))).toBe('a@x.example');
    expect(verifiedEmailFromIdToken(idToken({ email: 'a@x.example', email_verified: false }))).toBeUndefined();
    expect(verifiedEmailFromIdToken(idToken({ email: 'a@x.example' }))).toBeUndefined();
    expect(verifiedEmailFromIdToken('not-a-jwt')).toBeUndefined();
    expect(verifiedEmailFromIdToken(undefined)).toBeUndefined();
    expect(verifiedEmailFromIdToken(null)).toBeUndefined();
  });

  it('verifiedIdentityFromIdToken returns email, sub and hd only for a verified email', () => {
    const claims = { email: 'a@x.example', sub: '1234', hd: 'x.example' };
    expect(verifiedIdentityFromIdToken(idToken({ ...claims, email_verified: true }))).toEqual(claims);
    expect(verifiedIdentityFromIdToken(idToken({ ...claims, email_verified: 'true' }))).toEqual(claims);
    expect(verifiedIdentityFromIdToken(idToken({ ...claims, email_verified: false }))).toBeUndefined();
    expect(verifiedIdentityFromIdToken(idToken(claims))).toBeUndefined();
    expect(verifiedIdentityFromIdToken('not-a-jwt')).toBeUndefined();
    expect(verifiedIdentityFromIdToken(undefined)).toBeUndefined();
    expect(verifiedIdentityFromIdToken(idToken({ email: 'c@consumer.example', email_verified: true, sub: '99' }))).toEqual({ email: 'c@consumer.example', sub: '99' });
  });

  it('verifiedIdentityFromIdToken drops a sub that is not a 1-255 character printable string, and an hd that is not a domain', () => {
    const identity = (extra: Record<string, unknown>) => verifiedIdentityFromIdToken(idToken({ email: 'a@x.example', email_verified: true, ...extra }));
    for (const sub of [1234, '', 'x'.repeat(256), '12 34', '12\u00e934']) expect(identity({ sub })).toEqual({ email: 'a@x.example' });
    expect(identity({ sub: 'x'.repeat(255) })?.sub).toBe('x'.repeat(255));
    const longHd = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`;
    expect(longHd).toHaveLength(254);
    for (const hd of ['x', 'a b.c', longHd, 7, '.x.example', 'x.example.', 'x..example']) expect(identity({ hd })).toEqual({ email: 'a@x.example' });
    expect(identity({ hd: longHd.slice(1) })?.hd).toBe(longHd.slice(1));
    expect(identity({ hd: 'Sub-1.X.example' })?.hd).toBe('Sub-1.X.example');
  });
});
