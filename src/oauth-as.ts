// B13: the minimal OAuth 2.1 Authorization Server + Resource Server
// (oauth-authorization-server.md). Federate-and-hold: the server mints its own
// audience-bound HS256 token for the MCP client (leg A), gates on an owner
// Google login (leg B, tokens discarded), and separately holds per-alias Google
// tokens (leg C, unchanged). Mounts into B12's HttpTransportHost as `routes` +
// an `authenticate` for POST /mcp. All Google/CIMD I/O is injectable so the
// whole surface is exercised by an offline harness.

import { createHash, randomBytes } from 'node:crypto';
import { isIPv4 } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthOutcome, RouteHandler } from './http-transport.js';
import {
  signAccessToken, verifyAccessToken, signState, verifyState, signAuthzCode, verifyAuthzCode,
  signPending, verifyPending,
  ReplayGuard, RefreshStore, STATE_TTL_DEFAULT, CODE_TTL_DEFAULT, ACCESS_TTL_DEFAULT,
  type StatePayload,
} from './mcp-token.js';
import { fetchCimdDocument, SsrfBlockedError } from './ssrf-guard.js';

const CLAUDE_AI_FIXED_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

// DCR (/register) is public + unauthenticated, so its in-memory store must be
// bounded like every sibling store (ReplayGuard cap, RefreshStore SPENT_CAP) or
// a request loop OOMs the process. Cap client count (FIFO-evict the oldest) and
// the per-request redirect_uris shape so one entry can't be arbitrarily large.
export const DCR_MAX_CLIENTS = 1000;
export const DCR_MAX_REDIRECT_URIS = 10;
const DCR_MAX_URI_LEN = 2048;

export interface GoogleExchangeResult {
  tokens: Record<string, unknown>;
  email?: string;
}

export interface AuthServerConfig {
  base: string;
  resourceUri: string; // `${base}/mcp`
  secret: Uint8Array;
  ownerEmails: string[]; // lowercased
  cimdIssuers: string[]; // host allowlist, e.g. ['claude.ai']
  accessTtlSec?: number;
  masterKey: string;
  refreshStorePath: string;
}

export interface AuthServerDeps {
  fetchCimd?: (clientId: string) => Promise<Record<string, unknown>>;
  /** Exchange a Google auth code at `${base}/callback` for tokens (+ owner email). */
  exchangeCode?: (code: string, flow: StatePayload['flow']) => Promise<GoogleExchangeResult>;
  /** Build the Google authorization URL (redirect back to `${base}/callback`).
   *  The impl chooses scope/prompt/login_hint from the flow: owner_gate =
   *  `openid email` + select_account; alias_reauth = the alias's resource scopes
   *  + consent. */
  buildGoogleAuthUrl?: (opts: { flow: StatePayload['flow']; alias?: string; state: string }) => string;
  writeToken?: (alias: string, tokens: Record<string, unknown>) => void;
  registeredClients?: Map<string, { redirect_uris: string[] }>;
  replayGuard?: ReplayGuard;
  refreshStore?: RefreshStore;
  now?: () => number; // ms
  /** Server-side log (never sent to callers) for auth failures / SSRF blocks. */
  log?: (line: string) => void;
  /** The alias's configured Google email, for the alias_reauth identity binding. */
  aliasEmail?: (alias: string) => string | undefined;
}

export interface AuthServer {
  routes: Record<string, RouteHandler>;
  authenticate: (req: IncomingMessage) => Promise<AuthOutcome>;
}

// --- helpers ----------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): true {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(body));
  return true;
}

function errorPage(res: ServerResponse, status: number, slug: string, message: string): true {
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(`${slug}: ${message}`);
  return true;
}

function redirect(res: ServerResponse, location: string): true {
  res.writeHead(302, { Location: location });
  res.end();
  return true;
}

function isLoopbackHostname(h: string): boolean {
  const host = h.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '::ffff:127.0.0.1') return true;
  // 127.0.0.0/8 — must be a genuine IPv4 literal in range, NOT merely a "127."
  // prefix (which would let "127.evil.com" masquerade as loopback).
  return isIPv4(host) && host.split('.')[0] === '127';
}

/** C6: exact redirect_uri match, with RFC 8252 §7.3 port-agnostic loopback and
 *  the fixed claude.ai callback. */
export function redirectAllowed(redirectUri: string, docRedirectUris: string[]): boolean {
  if (redirectUri === CLAUDE_AI_FIXED_CALLBACK) return true;
  if (docRedirectUris.includes(redirectUri)) return true;
  let r: URL;
  try {
    r = new URL(redirectUri);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(r.hostname)) return false; // non-loopback must be exact
  return docRedirectUris.some((d) => {
    let du: URL;
    try {
      du = new URL(d);
    } catch {
      return false;
    }
    // any loopback host + any port + same scheme + same path
    return isLoopbackHostname(du.hostname) && du.protocol === r.protocol && du.pathname === r.pathname;
  });
}

function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function parseForm(raw: string, contentType: string | undefined): Record<string, string> {
  if (contentType?.includes('application/json')) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = String(v);
      return out;
    } catch {
      return {};
    }
  }
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

// --- the AS -----------------------------------------------------------------

export function buildAuthServer(config: AuthServerConfig, deps: AuthServerDeps = {}): AuthServer {
  const base = config.base;
  const resource = config.resourceUri;
  const secret = config.secret;
  const accessTtl = config.accessTtlSec ?? ACCESS_TTL_DEFAULT;
  const cimd = deps.fetchCimd ?? ((clientId: string) => fetchCimdDocument(clientId));
  const replay = deps.replayGuard ?? new ReplayGuard();
  const refresh = deps.refreshStore ?? new RefreshStore(config.refreshStorePath, config.masterKey);
  const registered = deps.registeredClients ?? new Map<string, { redirect_uris: string[] }>();
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => undefined);
  const nowSec = () => Math.floor(now() / 1000);
  const issHeader = { 'Cache-Control': 'no-store' };

  const prm = {
    resource,
    authorization_servers: [base],
    scopes_supported: ['mcp:use'],
    bearer_methods_supported: ['header'],
  };
  const asMetadata = {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    scopes_supported: ['mcp:use'],
  };

  const cimdCache = new Map<string, { doc: Record<string, unknown>; exp: number }>();
  const CIMD_CACHE_TTL_MS = 5 * 60_000;

  async function validateClient(clientId: string): Promise<{ redirect_uris: string[]; dcr: boolean } | { error: string; message: string }> {
    const reg = registered.get(clientId);
    if (reg) return { redirect_uris: reg.redirect_uris, dcr: true };
    // C7/#5: validate the issuer host + scheme BEFORE any outbound fetch, so we
    // only ever fetch an allowlisted issuer (no arbitrary-URL SSRF surface).
    let issuerHost: string;
    let scheme: string;
    try {
      const u = new URL(clientId);
      issuerHost = u.hostname;
      scheme = u.protocol;
    } catch {
      return { error: 'E_CIMD_INVALID', message: 'invalid client' };
    }
    if (scheme !== 'https:' || !config.cimdIssuers.includes(issuerHost)) {
      log(`CIMD rejected: client_id ${clientId} issuer not allowlisted`);
      return { error: 'E_CIMD_INVALID', message: 'invalid client' };
    }
    let doc: Record<string, unknown>;
    const cached = cimdCache.get(clientId);
    if (cached && cached.exp > now()) {
      doc = cached.doc;
    } else {
      try {
        doc = await cimd(clientId);
      } catch (e) {
        // #13: never echo internal fetch details to the caller (blind-SSRF
        // oracle); log server-side, return a generic message.
        log(`CIMD fetch failed for ${clientId}: ${(e as Error).message}`);
        const slug = e instanceof SsrfBlockedError ? 'E_CIMD_SSRF_BLOCKED' : 'E_CIMD_INVALID';
        return { error: slug, message: 'invalid client' };
      }
      cimdCache.set(clientId, { doc, exp: now() + CIMD_CACHE_TTL_MS }); // #15
    }
    if (doc.client_id !== clientId) return { error: 'E_CIMD_INVALID', message: 'invalid client' };
    const uris = Array.isArray(doc.redirect_uris) ? (doc.redirect_uris as string[]) : [];
    if (uris.length === 0) return { error: 'E_CIMD_INVALID', message: 'invalid client' };
    // C6 #14: warn on a localhost-only redirect set (loopback impersonation).
    if (uris.every((u) => { try { return isLoopbackHostname(new URL(u).hostname); } catch { return false; } })) {
      log(`client ${clientId} advertises only loopback redirect_uris`);
    }
    return { redirect_uris: uris, dcr: false };
  }

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
  }

  async function toGoogle(res: ServerResponse, sp: StatePayload): Promise<true> {
    const state = await signState(sp, base, secret, nowSec());
    const authUrl = deps.buildGoogleAuthUrl
      ? deps.buildGoogleAuthUrl({ flow: sp.flow, alias: sp.alias, state })
      : `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(state)}`;
    return redirect(res, authUrl);
  }

  // GET /authorize (validate + interstitial for DCR clients); POST /authorize
  // (a DCR consent approval — verify the signed pending token, then proceed).
  const authorize: RouteHandler = async (req, res, url) => {
    if (req.method === 'POST') {
      let form: Record<string, string>;
      try {
        form = parseForm(await readBody(req), req.headers['content-type']);
      } catch {
        return errorPage(res, 400, 'invalid_request', 'bad form');
      }
      let pending: StatePayload & { jti: string };
      try {
        pending = await verifyPending(form.pending ?? '', base, secret);
      } catch {
        return errorPage(res, 400, 'E_STATE_INVALID', 'the approval is invalid or expired');
      }
      if (!replay.consume(pending.jti, STATE_TTL_DEFAULT * 1000, now())) {
        return errorPage(res, 400, 'E_STATE_INVALID', 'this approval was already used');
      }
      const { jti: _drop, ...sp } = pending;
      void _drop;
      return toGoogle(res, sp as StatePayload);
    }
    const q = url.searchParams;
    const clientId = q.get('client_id') ?? '';
    const redirectUri = q.get('redirect_uri') ?? '';
    const codeChallenge = q.get('code_challenge') ?? '';
    const method = q.get('code_challenge_method') ?? '';
    const resourceParam = q.get('resource') ?? '';
    const clientState = q.get('state') ?? undefined;
    const aliasParam = q.get('alias') ?? undefined;

    // In-call re-auth (BV-1): a user-clicked `flow=alias_reauth` link has NO
    // client leg — no code is delivered to any client, the refreshed token is
    // written server-side for the alias — so it skips the client_id/redirect/
    // PKCE requirements. Safe because /callback binds the completing Google
    // identity to the alias's configured email before writing anything.
    if (q.get('flow') === 'alias_reauth' && aliasParam && !clientId) {
      if (!deps.aliasEmail?.(aliasParam)) {
        return errorPage(res, 400, 'invalid_request', `unknown account "${aliasParam}"`);
      }
      return toGoogle(res, { flow: 'alias_reauth', client_id: '', redirect_uri: '', code_challenge: '', resource, alias: aliasParam });
    }

    if (!clientId) return json(res, 400, { error: 'invalid_request', message: 'client_id required', iss: base }, issHeader);
    const client = await validateClient(clientId);
    if ('error' in client) return json(res, 400, { error: 'invalid_client', message: client.message, iss: base }, issHeader);

    // (2) exact redirect_uri match BEFORE minting anything (open-redirect defense)
    if (!redirectUri || !redirectAllowed(redirectUri, client.redirect_uris)) {
      return errorPage(res, 400, 'E_REDIRECT_URI_MISMATCH', 'redirect_uri is not an allowed callback for this client');
    }
    // (3) PKCE S256 required
    if (!codeChallenge || method !== 'S256') {
      return json(res, 400, { error: 'invalid_request', message: 'code_challenge with S256 required', iss: base }, issHeader);
    }
    // (4) resource must be the canonical resource URI
    if (resourceParam !== resource) {
      return json(res, 400, { error: 'invalid_request', message: `resource must be ${resource}`, iss: base }, issHeader);
    }
    // (5) only after full validation do we build the request artifact.
    const statePayload: StatePayload = {
      flow: (q.get('flow') as StatePayload['flow']) === 'alias_reauth' ? 'alias_reauth' : 'owner_gate',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      client_state: clientState,
      resource,
      alias: q.get('alias') ?? undefined,
    };
    // Confused-deputy defense (#3): a self-registered DCR client can pick an
    // arbitrary redirect_uri, so before we send the owner to Google (whose
    // consent screen names only THIS server, not the requesting app), show an
    // approval interstitial naming the client + destination. CIMD clients skip
    // it — their redirect_uris come from an issuer-allowlisted document a rogue
    // cannot forge, so there is nothing to spoof.
    if (client.dcr) {
      const pendingToken = await signPending(statePayload, base, secret, nowSec());
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(
        `<!doctype html><meta charset=utf-8><title>Authorize access</title>` +
          `<body style="font-family:system-ui,sans-serif;max-width:36em;margin:3em auto;line-height:1.5">` +
          `<h2>Authorize access?</h2>` +
          `<p>A newly-registered application (<code>${escapeHtml(clientId)}</code>) is requesting access to your Google Workspace through this server.</p>` +
          `<p>If approved, it will receive an authorization redirected to:<br><code>${escapeHtml(redirectUri)}</code></p>` +
          `<p><strong>If you did not start this, close this window.</strong></p>` +
          `<form method="POST" action="/authorize"><input type="hidden" name="pending" value="${escapeHtml(pendingToken)}">` +
          `<button type="submit" style="font-size:1em;padding:.5em 1.5em">Approve</button></form></body>`,
      );
      return true;
    }
    return toGoogle(res, statePayload);
  };

  // GET /callback
  const callback: RouteHandler = async (req, res, url) => {
    const code = url.searchParams.get('code') ?? '';
    const stateToken = url.searchParams.get('state') ?? '';
    let st: StatePayload & { jti: string };
    try {
      st = await verifyState(stateToken, base, secret);
    } catch {
      return errorPage(res, 400, 'E_STATE_INVALID', 'state is invalid, expired, or tampered');
    }
    if (!replay.consume(st.jti, STATE_TTL_DEFAULT * 1000, now())) {
      return errorPage(res, 400, 'E_STATE_INVALID', 'state has already been used (replay)');
    }
    if (!code) return errorPage(res, 400, 'invalid_request', 'missing code');

    let exchanged: GoogleExchangeResult;
    try {
      exchanged = deps.exchangeCode ? await deps.exchangeCode(code, st.flow) : { tokens: {} };
    } catch (e) {
      return errorPage(res, 400, 'invalid_grant', `Google code exchange failed: ${(e as Error).message}`);
    }

    if (st.flow === 'alias_reauth') {
      if (!st.alias) return errorPage(res, 400, 'invalid_request', 'alias_reauth without an alias');
      // C13 / identity binding (#2/#6): only overwrite the alias's tokens if the
      // completing Google identity IS that alias's configured account — else an
      // attacker who crafts an alias_reauth link and logs in with their OWN
      // account could inject their tokens (account swap). The alias emails (leg
      // C) are distinct from MCP_OWNER_EMAILS (leg B), so bind to the alias.
      const gotEmail = (exchanged.email ?? '').toLowerCase();
      const expected = (deps.aliasEmail?.(st.alias) ?? '').toLowerCase();
      if (!expected || !gotEmail || gotEmail !== expected) {
        log(`alias_reauth identity mismatch for "${st.alias}" (got ${gotEmail || 'none'})`);
        return errorPage(res, 403, 'access_denied', 'the Google account you signed in with is not the one configured for this alias');
      }
      deps.writeToken?.(st.alias, exchanged.tokens);
      log(`callback ok flow=alias_reauth alias=${st.alias}`);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><meta charset=utf-8><p>Re-authenticated "${st.alias}". You can close this window.</p>`);
      return true;
    }

    // owner_gate: verify the email is an allowlisted owner, discard Google tokens
    const email = (exchanged.email ?? '').toLowerCase();
    const iss = encodeURIComponent(base);
    if (!email || !config.ownerEmails.includes(email)) {
      const sep = st.redirect_uri.includes('?') ? '&' : '?';
      const s = st.client_state ? `&state=${encodeURIComponent(st.client_state)}` : '';
      return redirect(res, `${st.redirect_uri}${sep}error=access_denied${s}&iss=${iss}`);
    }
    const authzCode = await signAuthzCode(
      { redirect_uri: st.redirect_uri, code_challenge: st.code_challenge, resource: st.resource, sub: 'owner' },
      base,
      secret,
      nowSec(),
    );
    log('callback ok flow=owner_gate');
    const sep = st.redirect_uri.includes('?') ? '&' : '?';
    const s = st.client_state ? `&state=${encodeURIComponent(st.client_state)}` : '';
    return redirect(res, `${st.redirect_uri}${sep}code=${encodeURIComponent(authzCode)}${s}&iss=${iss}`);
  };

  // POST /token
  const token: RouteHandler = async (req, res) => {
    let form: Record<string, string>;
    try {
      form = parseForm(await readBody(req), req.headers['content-type']);
    } catch {
      return json(res, 400, { error: 'invalid_request', message: 'bad body' });
    }
    const grant = form.grant_type;
    if (grant === 'authorization_code') {
      let code: Awaited<ReturnType<typeof verifyAuthzCode>>;
      try {
        code = await verifyAuthzCode(form.code ?? '', base, secret);
      } catch {
        return json(res, 400, { error: 'invalid_grant', message: 'authorization code invalid or expired' });
      }
      if (!replay.consume(code.jti, CODE_TTL_DEFAULT * 1000, now())) {
        return json(res, 400, { error: 'invalid_grant', message: 'authorization code already redeemed' });
      }
      if (form.redirect_uri !== code.redirect_uri) {
        return json(res, 400, { error: 'invalid_grant', message: 'redirect_uri mismatch' });
      }
      if (form.resource && form.resource !== code.resource) {
        return json(res, 400, { error: 'invalid_grant', message: 'resource mismatch' });
      }
      if (!form.code_verifier || pkceS256(form.code_verifier) !== code.code_challenge) {
        return json(res, 400, { error: 'invalid_grant', message: 'PKCE verification failed' });
      }
      const access = await signAccessToken({ base, secret, iat: nowSec(), ttlSec: accessTtl });
      const refreshToken = refresh.issue(now());
      log('token issued grant=authorization_code');
      return json(res, 200, { access_token: access, token_type: 'Bearer', expires_in: accessTtl, refresh_token: refreshToken, scope: 'mcp:use' });
    }
    if (grant === 'refresh_token') {
      const next = refresh.rotate(form.refresh_token ?? '', now());
      if (!next) return json(res, 400, { error: 'invalid_grant', message: 'unknown or rotated refresh token' });
      const access = await signAccessToken({ base, secret, iat: nowSec(), ttlSec: accessTtl });
      log('token issued grant=refresh_token');
      return json(res, 200, { access_token: access, token_type: 'Bearer', expires_in: accessTtl, refresh_token: next, scope: 'mcp:use' });
    }
    return json(res, 400, { error: 'unsupported_grant_type', message: 'authorization_code or refresh_token only' });
  };

  // POST /register (minimal DCR, D2). Parse the raw JSON body directly (the
  // redirect_uris array must survive intact).
  const register: RouteHandler = async (req, res) => {
    let parsed: { redirect_uris?: unknown };
    try {
      parsed = JSON.parse(await readBody(req)) as { redirect_uris?: unknown };
    } catch {
      return json(res, 400, { error: 'invalid_client_metadata', message: 'a JSON body with redirect_uris is required' });
    }
    const redirectUris = Array.isArray(parsed.redirect_uris) ? parsed.redirect_uris.map(String) : [];
    if (redirectUris.length === 0) return json(res, 400, { error: 'invalid_client_metadata', message: 'redirect_uris required' });
    if (redirectUris.length > DCR_MAX_REDIRECT_URIS || redirectUris.some((u) => u.length > DCR_MAX_URI_LEN)) {
      return json(res, 400, { error: 'invalid_client_metadata', message: 'too many or oversized redirect_uris' });
    }
    // Bound the store: FIFO-evict the oldest registration once at capacity (Map
    // preserves insertion order) so a /register flood can't grow RSS unbounded.
    while (registered.size >= DCR_MAX_CLIENTS) {
      const oldest = registered.keys().next().value;
      if (oldest === undefined) break;
      registered.delete(oldest);
    }
    const clientId = `mcpb-${randomBytes(16).toString('hex')}`;
    registered.set(clientId, { redirect_uris: redirectUris });
    return json(res, 201, { client_id: clientId, redirect_uris: redirectUris, token_endpoint_auth_method: 'none' });
  };

  const wellKnownPrm: RouteHandler = (req, res) => json(res, 200, prm);
  const wellKnownAs: RouteHandler = (req, res) => json(res, 200, asMetadata);

  const routes: Record<string, RouteHandler> = {
    '/.well-known/oauth-protected-resource': wellKnownPrm,
    '/.well-known/oauth-protected-resource/mcp': wellKnownPrm,
    '/.well-known/oauth-authorization-server': wellKnownAs,
    '/authorize': authorize,
    '/callback': callback,
    '/token': token,
    '/register': register,
  };

  const wwwAuth = `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", scope="mcp:use"`;
  const authenticate = async (req: IncomingMessage): Promise<AuthOutcome> => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return { ok: false, status: 401, headers: { 'WWW-Authenticate': wwwAuth }, body: JSON.stringify({ error: 'E_MCP_TOKEN_INVALID', message: 'missing bearer token' }) };
    }
    try {
      await verifyAccessToken(header.slice(7), base, secret);
      return { ok: true };
    } catch {
      return { ok: false, status: 401, headers: { 'WWW-Authenticate': wwwAuth }, body: JSON.stringify({ error: 'E_MCP_TOKEN_INVALID', message: 'invalid or expired token' }) };
    }
  };

  return { routes, authenticate };
}
