// B12: the Streamable HTTP transport host (cc-transport-hosting T2/T3). Owns the
// node:http server, the route table, the front guard (Host / Origin / DNS-rebind),
// and the stateless per-request /mcp dispatch. The OAuth AS endpoints and Bearer
// verification are a seam filled by B13 (oauth-authorization-server); B12 ships a
// loopback-owner authenticator so the local-HTTP model works before the AS lands.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HttpConfig } from './http-config.js';

export type AuthOutcome =
  | { ok: true }
  | { ok: false; status: number; body: string; headers?: Record<string, string> };

/** Bearer / owner check for POST /mcp. B12 default = loopback-owner; B13 swaps in JWT verify. */
export type Authenticator = (req: IncomingMessage) => AuthOutcome | Promise<AuthOutcome>;

/** A mounted extra route (the AS endpoints, B13). Return true if it wrote a response. */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean | Promise<boolean>;

export interface HttpHostOptions {
  /** The ONE McpServer + registry built at boot (P1 / BV gap #4: never per request). */
  server: McpServer;
  config: HttpConfig;
  version: string;
  ownerConfigured: boolean;
  authenticate: Authenticator;
  /** Extra routes keyed by exact pathname (AS endpoints mount here in B13). */
  routes?: Record<string, RouteHandler>;
  log?: (line: string) => void;
  /** Max /mcp JSON body bytes (DoS guard). */
  maxBodyBytes?: number;
}

export function parseOwnerEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.MCP_OWNER_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Front guard: an Origin, if present, must be allowlisted; a Host must be
 * allowlisted. Absent Origin passes (native/CLI/backend clients — the claude.ai
 * connector calls /mcp server-to-server with no Origin, BV-4). */
export function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return true;
  return allowed.includes(origin);
}

export function hostAllowed(host: string | undefined, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  if (!host) return false;
  // Port-agnostic, matching the SDK's DNS-rebind guard: allow an exact match or
  // the bare hostname (allowedHosts carries both host[:port] and bare forms).
  const bare = host.replace(/:\d+$/, '');
  return allowed.includes(host) || allowed.includes(bare);
}


export class HttpTransportHost {
  private httpServer?: Server;
  // Serialize the connect→dispatch critical section: the shared McpServer
  // captures its transport per request (protocol.js), but the gap between
  // connect() and the dispatch capturing it would still race under true
  // concurrency. Single-owner HTTP traffic is effectively serial, so a mutex
  // keeps correctness at negligible cost (and never rebuilds the registry).
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: HttpHostOptions) {}

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run as Promise<T>;
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }

  async start(): Promise<void> {
    const { config } = this.opts;
    const server = createServer((req, res) => {
      this.handle(req, res).catch((e) => this.fail(res, 500, 'internal_error', (e as Error).message));
    });
    // Slow-loris mitigation behind the tunnel.
    server.headersTimeout = 15_000;
    server.requestTimeout = 30_000;
    this.httpServer = server;
    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error) => reject(e);
      server.once('error', onErr);
      server.listen(config.port, config.host, () => {
        server.off('error', onErr);
        resolve();
      });
    });
    this.log(`listening on ${config.host}:${config.port} (public ${config.publicUrl}, transport ${config.transport})`);
  }

  async close(): Promise<void> {
    const s = this.httpServer;
    if (!s) return;
    await new Promise<void>((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections?.();
    });
    this.httpServer = undefined;
  }

  /** The bound port (useful when listening on port 0 in tests). */
  address(): { port: number } | undefined {
    const a = this.httpServer?.address();
    return a && typeof a === 'object' ? { port: a.port } : undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // req.url is the path+query; parse against a FIXED base so a malformed/hostile
    // Host header can't throw here (the Host is validated in the front guard).
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/health') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return this.fail(res, 405, 'method_not_allowed', 'GET /health only');
      }
      return this.health(res);
    }

    const route = this.opts.routes?.[path];
    if (route) {
      if (!this.frontGuard(req, res)) return;
      const handled = await route(req, res, url);
      if (!handled && !res.writableEnded) this.fail(res, 404, 'not_found', `No handler for ${path}`);
      return;
    }

    if (path === '/mcp') return this.mcp(req, res);

    this.fail(res, 404, 'not_found', `Unknown path ${path}`);
  }

  private frontGuard(req: IncomingMessage, res: ServerResponse): boolean {
    const { allowedHosts, allowedOrigins } = this.opts.config;
    if (!hostAllowed(req.headers.host, allowedHosts)) {
      this.log(`403 host_rejected host=${req.headers.host ?? ''}`);
      this.fail(res, 403, 'host_rejected', 'Host not allowed (DNS-rebinding guard).');
      return false;
    }
    if (!originAllowed(req.headers.origin, allowedOrigins)) {
      this.log(`403 origin_rejected origin=${req.headers.origin ?? ''}`);
      this.fail(res, 403, 'origin_rejected', 'Origin not allowed.');
      return false;
    }
    return true;
  }

  private async mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return this.fail(res, 405, 'method_not_allowed', 'POST /mcp only (stateless mode; no GET SSE).');
    }
    if (!this.frontGuard(req, res)) return;

    const auth = await this.opts.authenticate(req);
    if (!auth.ok) {
      for (const [k, v] of Object.entries(auth.headers ?? {})) res.setHeader(k, v);
      res.writeHead(auth.status, { 'Content-Type': 'application/json' });
      res.end(auth.body);
      this.log(`${auth.status} auth_failed path=/mcp`);
      return;
    }

    let body: unknown;
    try {
      body = await this.readJson(req);
    } catch (e) {
      return this.fail(res, 400, 'invalid_body', (e as Error).message);
    }

    // Host/Origin are enforced by the front guard above (uniformly for /mcp and
    // the mounted AS routes), so the SDK's own DNS-rebind guard is disabled: its
    // exact-Host match is stricter than the front guard and would 403 valid
    // Hosts (double enforcement, differing rules).
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: false,
    });
    // The shared McpServer holds exactly one connected transport at a time, so
    // connect + dispatch + DISCONNECT all run inside the mutex: the next request
    // can never hit "Already connected", and a client disconnect can't wedge the
    // lock — dispatch is raced against res 'close' so it always settles, and the
    // transport is closed in a finally (which resets server._transport) before
    // the lock releases. (A shared initialized-state persists across stateless
    // requests; benign for the single-owner design.)
    await this.serialize(async () => {
      const disconnected = new Promise<void>((resolve) => res.once('close', resolve));
      await this.opts.server.connect(transport);
      try {
        await Promise.race([transport.handleRequest(req, res, body), disconnected]);
      } finally {
        await transport.close().catch(() => undefined);
      }
    });
  }

  private health(res: ServerResponse): void {
    const { config, ownerConfigured, version } = this.opts;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // No secrets, no owner emails (cc-transport-hosting /health rule).
    res.end(
      JSON.stringify({
        status: 'ok',
        transport: config.transport,
        publicUrl: config.publicUrl,
        ownerConfigured,
        version,
      }),
    );
  }

  private readJson(req: IncomingMessage): Promise<unknown> {
    const max = this.opts.maxBodyBytes ?? 4_000_000;
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > max) {
          reject(new Error('request body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (raw.trim() === '') return resolve(undefined);
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error('request body is not valid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  private fail(res: ServerResponse, status: number, error: string, message: string): void {
    if (res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error, message }));
  }
}
