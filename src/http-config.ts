// Transport selection + public-base-URL / Origin / host config plumbing (B11).
// Pure, resolved once at boot; the HTTP host that consumes this lands in B12
// (cc-transport-hosting) and the AS metadata in B13 (oauth-authorization-server).
// Owns the canonicalization rule (cc-transport-hosting BR4): a single mismatch
// between the advertised resource URI and the client's `resource`/`aud` = a
// perpetual 401 loop (the #1 interop bug), so it is normalized exactly once.

export type Transport = 'stdio' | 'http' | 'both';

export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const DEFAULT_HTTP_PORT = 4243;
export const CLAUDE_AI_ORIGIN = 'https://claude.ai';

/** Slug-carrying boot-time config failure; caller surfaces the message. */
export class HttpConfigError extends Error {
  constructor(
    readonly slug: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpConfigError';
  }
}

export interface HttpConfig {
  transport: Transport;
  host: string;
  port: number;
  /** Canonical public base URL (BR4): lowercase scheme+host, no default port,
   *  no trailing slash, no fragment/query. The issuer and every advertised
   *  endpoint derive from this. */
  publicUrl: string;
  /** `${publicUrl}/mcp` — the canonical resource URI (JWT `aud` / PRM `resource`). */
  resourceUri: string;
  /** DNS-rebind Host allowlist. Both host[:port] and bare-host forms are
   *  included: the Host header may or may not carry the port depending on the
   *  client/proxy, and a too-narrow allowlist is a silent 403. */
  allowedHosts: string[];
  /** Origin allowlist for the front guard (publicUrl origin + claude.ai + extras). */
  allowedOrigins: string[];
}

export function transportIncludesHttp(t: Transport): boolean {
  return t === 'http' || t === 'both';
}

export function resolveTransport(env: NodeJS.ProcessEnv = process.env): Transport {
  const raw = (env.MCP_TRANSPORT ?? '').trim().toLowerCase();
  if (raw === '') return 'stdio';
  if (raw === 'stdio' || raw === 'http' || raw === 'both') return raw;
  // Load-bearing (decides whether a port opens): fail fast rather than silently
  // downgrade — a user who set `http` and got stdio would be badly confused.
  throw new HttpConfigError(
    'E_INVALID_TRANSPORT',
    `MCP_TRANSPORT must be one of stdio|http|both (got "${env.MCP_TRANSPORT}")`,
  );
}

/**
 * Canonicalize a public base URL per BR4. WHATWG `URL` already lowercases the
 * scheme+host and omits a default port from `.host`; this adds the HTTPS-only
 * scheme check, strips fragment/query/userinfo, and removes a trailing slash.
 */
export function canonicalizePublicUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpConfigError('E_PUBLIC_URL_INVALID', `MCP_PUBLIC_URL is not a valid absolute URL: "${raw}"`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new HttpConfigError('E_PUBLIC_URL_INVALID', `MCP_PUBLIC_URL must be http(s) (got "${raw}")`);
  }
  u.hash = '';
  u.search = '';
  u.username = '';
  u.password = '';
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

function resolvePort(raw: string | undefined): number {
  const s = (raw ?? '').trim();
  if (s === '') return DEFAULT_HTTP_PORT;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new HttpConfigError('E_INVALID_HTTP_PORT', `MCP_HTTP_PORT must be an integer 1-65535 (got "${raw}")`);
  }
  return n;
}

/** `host:port`, bracketing a bare IPv6 literal so it is a valid URL authority. */
function hostPort(host: string, port: number): string {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${h}:${port}`;
}

function deriveAllowedHosts(publicUrl: string, host: string, port: number): string[] {
  const pu = new URL(publicUrl);
  const set = new Set<string>();
  set.add(pu.host); // hostname[:port]
  set.add(pu.hostname); // bare hostname
  set.add(host);
  set.add(hostPort(host, port));
  return [...set];
}

function deriveAllowedOrigins(publicUrl: string, extra: string | undefined): string[] {
  const set = new Set<string>();
  set.add(new URL(publicUrl).origin);
  set.add(CLAUDE_AI_ORIGIN);
  for (const raw of (extra ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    let o: string;
    try {
      o = new URL(raw).origin;
    } catch {
      throw new HttpConfigError('E_INVALID_ORIGIN', `MCP_ALLOWED_ORIGINS entry is not a valid URL: "${raw}"`);
    }
    if (o === 'null') {
      throw new HttpConfigError('E_INVALID_ORIGIN', `MCP_ALLOWED_ORIGINS entry has no usable origin: "${raw}"`);
    }
    set.add(o);
  }
  return [...set];
}

export function resolveHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const transport = resolveTransport(env);
  const host = (env.MCP_HTTP_HOST ?? '').trim() || DEFAULT_HTTP_HOST;
  const port = resolvePort(env.MCP_HTTP_PORT);
  const rawPublic = (env.MCP_PUBLIC_URL ?? '').trim() || `http://${hostPort(host, port)}`;
  const publicUrl = canonicalizePublicUrl(rawPublic);
  return {
    transport,
    host,
    port,
    publicUrl,
    resourceUri: `${publicUrl}/mcp`,
    allowedHosts: deriveAllowedHosts(publicUrl, host, port),
    allowedOrigins: deriveAllowedOrigins(publicUrl, env.MCP_ALLOWED_ORIGINS),
  };
}
