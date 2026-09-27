// B12: the Streamable HTTP transport host (cc-transport-hosting T2/T3). Owns the
import type { McpServer, Transport, AuthInfo } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";

// node:http server, the route table, the front guard (Host / Origin / DNS-rebind),
// and the stateless per-request /mcp dispatch. The OAuth AS endpoints and Bearer
// verification are a seam filled by B13 (oauth-authorization-server); B12 ships a
// loopback-owner authenticator so the local-HTTP model works before the AS lands.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { Socket } from 'node:net';
import type { HttpConfig } from './http-config.js';
import { withArgNormalization, type ArgShape, type StrictArgOptions, withValidationEnvelope, type ValidationEnvelopeOptions } from './arg-normalize.js';
export type AuthOutcome =
  | { ok: true; sub?: string }
  | { ok: false; status: number; body: string; headers?: Record<string, string> };

/** Bearer / owner check for POST /mcp. B12 default = loopback-owner; B13 swaps in JWT verify. */
export type Authenticator = (req: IncomingMessage) => AuthOutcome | Promise<AuthOutcome>;

/** A mounted extra route (the AS endpoints, B13). Return true if it wrote a response. */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean | Promise<boolean>;

/** What a verified subject resolves to: ITS server plus the per-request hooks
 * bound to that server's registry (tool shapes, declared keys, the default
 * account a validation envelope names). The metrics observers (metricsTap,
 * onArgRename) stay host-wide and must not be bound to any one registry. */
export interface ServerTarget {
  server: McpServer;
  argShapeFor?: (tool: string) => ArgShape | undefined;
  strictArgs?: StrictArgOptions;
  validationEnvelope?: ValidationEnvelopeOptions;
}

export interface HttpHostOptions {
  /** The ONE McpServer + registry built at boot (P1 / BV gap #4: never per request). */
  server: McpServer;
  config: HttpConfig;
  version: string;
  ownerConfigured: boolean;
  authenticate: Authenticator;
  /** Tenant-resolution seam: map the verified subject to ITS server. Absent
   * (free core) = every request dispatches to the one boot `server`. Return
   * null for an unknown subject -> 403 tenant_not_found. Each distinct
   * resolved server gets its own dispatch lane. With a resolver, the
   * per-request hooks come from the resolved target ONLY: the host-level
   * argShapeFor / strictArgs / validationEnvelope describe the boot server's
   * registry, never another subject's. */
  resolveServer?: (claims: { sub: string }) => Promise<ServerTarget | null> | ServerTarget | null;
  /** Extra routes keyed by exact pathname (AS endpoints mount here in B13). */
  routes?: Record<string, RouteHandler>;
  log?: (line: string) => void;
  /** Max /mcp JSON body bytes (DoS guard). */
  maxBodyBytes?: number;
  /** Deadline for a single /mcp dispatch; a hung handler past this releases the
   * shared lock instead of wedging the transport (default 120s). */
  dispatchTimeoutMs?: number;
  /** tools/call argument-key normalization lookup (arg-normalize.ts); absent = off. */
  argShapeFor?: (tool: string) => ArgShape | undefined;
  /** Usage-metrics transport tap (metrics-tap.ts); absent = off. */
  metricsTap?: (t: Transport) => Transport;
  /** Wired identically on both transports so a schema rejection reads the same
   * over stdio and over HTTP. */
  validationEnvelope?: ValidationEnvelopeOptions;
  /** Usage-metrics argfix observer, forwarded into arg normalization. */
  onArgRename?: (tool: string, renames: number) => void;
  /** Unknown-argument screening (arg-strict.ts); absent = off. */
  strictArgs?: StrictArgOptions;
  /** Per-server cap on /mcp requests reading their body, queued or running;
   * the next answers 429 lane_busy before its body is read. Unset = no cap. */
  maxQueuedPerLane?: number;
  /** Max JSON-RPC messages in one /mcp body (default 16). */
  maxBatchFrames?: number;
}

// A hung handler that keeps the connection open would otherwise hold the global
// serialize() lock forever. Generous by default so slow-but-valid calls (large
// Drive exports, fan-out) still finish; the point is only to guarantee release.
const DISPATCH_TIMEOUT_DEFAULT = 120_000;
/** MCP 2025-06-18 dropped JSON-RPC batching, and the SDK screens every frame
 * of a batch synchronously in one tick: without a cap one body multiplies the
 * per-call work by however many frames fit in it. */
const MAX_BATCH_FRAMES = 16;

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

/** JSON-RPC method name(s) for an observability log line — no params, no PII. */
export function jsonRpcMethod(body: unknown): string {
  const one = (b: unknown): string | undefined =>
    b && typeof b === 'object' && 'method' in b ? String((b as { method: unknown }).method) : undefined;
  if (Array.isArray(body)) return body.map(one).filter(Boolean).join(',') || 'batch';
  return one(body) ?? 'unknown';
}


/** setTimeout fires at once for a delay above this, so a longer grace would
 * cut every connection immediately. */
const MAX_GRACE_MS = 2 ** 31 - 1;

// A lingering close: a socket destroyed while its client is still sending (a
// body pipelined after the close) is reset by the kernel, which drops whatever
// of the last response is still unsent. So the socket only ends its side and
// waits for the client's FIN, or for the grace to end.
function endAfterFlush(socket: Socket): void {
  if (socket.destroyed || socket.writableEnded) return;
  socket.end();
}

// A request that arrives while closing is never answered, so Node keeps it
// until the socket closes, and a flood pipelined behind a held response would
// pile up without limit. Reading stops for good instead, which lets TCP flow
// control stop the client. Node resumes a socket after every parsed request
// and on drain, so resume becomes a no-op. Such a socket never sees the
// client's FIN either: the grace ends it.
function stopReading(socket: Socket): void {
  socket.pause();
  socket.resume = () => socket;
}

// For a log line: the pathname only (a query can carry a code or a state),
// and never a throw, since the caller is the catch-all.
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    return '?';
  }
}

export class HttpTransportHost {
  private httpServer?: Server;
  // Serialize the connect→dispatch critical section PER SERVER: a McpServer
  // captures its transport per request (protocol.js), but the gap between
  // connect() and the dispatch capturing it would still race under true
  // concurrency, so all traffic to ONE server runs under one mutex. The free
  // core has one lane (the boot server); with resolveServer each resolved
  // server gets its own, however subjects map onto servers.
  private readonly locks = new Map<McpServer, Promise<unknown>>();
  // Requests holding a lane slot, per server; used only with maxQueuedPerLane.
  private readonly depth = new Map<McpServer, number>();
  // What a graceful close waits on: open sockets, per socket the requests it
  // has accepted whose response has not settled and the last of them, and
  // every handle() that has not settled.
  private readonly sockets = new Set<Socket>();
  private readonly pending = new Map<Socket, { count: number; last: ServerResponse }>();
  private readonly handling = new Set<Promise<void>>();
  private closing = false;
  private graceful?: Promise<void>;

  constructor(private readonly opts: HttpHostOptions) {}

  private serializeFor<T>(key: McpServer, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, tail);
    // An idle lane drops out, so the map holds only in-flight subjects rather
    // than every subject ever seen. A request that chained on this tail has
    // already replaced it, so the identity check never frees a live lane.
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run as Promise<T>;
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }

  async start(): Promise<void> {
    const { config } = this.opts;
    const server = createServer((req, res) => {
      const socket = req.socket;
      // Once closing, a connection ends after the last request it accepted
      // before the close, so one arriving now is never handled (RFC 9112 9.6).
      // Its body is left unread: nothing reads the socket again.
      if (this.closing) {
        stopReading(socket);
        return;
      }
      const entry = this.pending.get(socket);
      if (entry) {
        entry.count++;
        entry.last = res;
      } else this.pending.set(socket, { count: 1, last: res });
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        const e = this.pending.get(socket);
        if (!e || --e.count > 0) return;
        this.pending.delete(socket);
        if (this.closing) endAfterFlush(socket);
      };
      res.once('finish', settle);
      res.once('close', settle);
      // Never rejects: close() waits on it, and a catch-all that itself threw
      // must neither reject close() nor surface as an unhandled rejection.
      // The thrown message can name server paths (a lock timeout does), so it
      // goes only to the host's log.
      const done = this.handle(req, res)
        .catch((e) => {
          try {
            this.fail(res, 500, 'internal_error', 'internal error');
          } finally {
            // A throwing log must not reach the destroy below: the answer is sent.
            try {
              this.log(`500 internal_error path=${pathOf(req)}: ${e instanceof Error ? e.message : 'non-Error throw'}`);
            } catch {
              // nowhere left to report it
            }
          }
        })
        .catch(() => void res.destroy());
      this.handling.add(done);
      void done.finally(() => this.handling.delete(done));
    });
    server.on('connection', (socket: Socket) => {
      this.sockets.add(socket);
      socket.once('close', () => {
        this.sockets.delete(socket);
        this.pending.delete(socket);
      });
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

  /** Without graceMs, every connection is cut at once, even during a graceful
   * close. With it, the host stops accepting, lets in-flight requests finish
   * and their responses finish writing, then resolves once each client has
   * closed its side; whatever is still open after graceMs is cut. A repeat
   * call with graceMs during a graceful close joins it, keeping the first
   * grace. graceMs must be a number from 0 to 2^31-1 ms (about 24.8 days, the
   * longest delay a timer holds); anything else, Infinity included, rejects
   * with a TypeError and leaves the host as it was. */
  async close(opts: { graceMs?: number } = {}): Promise<void> {
    const { graceMs } = opts;
    if (graceMs !== undefined && !(typeof graceMs === 'number' && graceMs >= 0 && graceMs <= MAX_GRACE_MS)) {
      throw new TypeError(`graceMs must be a number from 0 to ${MAX_GRACE_MS}`);
    }
    const s = this.httpServer;
    if (!s) return;
    if (graceMs === undefined) {
      await new Promise<void>((resolve) => {
        s.close(() => resolve());
        s.closeAllConnections?.();
      });
      this.httpServer = undefined;
      return;
    }
    // Starting over would destroy every socket in its lingering close.
    this.graceful ??= this.closeGracefully(s, graceMs).finally(() => (this.graceful = undefined));
    return this.graceful;
  }

  private async closeGracefully(s: Server, graceMs: number): Promise<void> {
    this.closing = true;
    // Node's close() also destroys every connection it deems idle, and that
    // includes one whose response has ended but is still flushing: a large
    // body would be cut short. Idle sockets are closed below instead.
    const nodeIdleCloser = s.closeIdleConnections;
    s.closeIdleConnections = () => undefined;
    const closed = new Promise<void>((resolve) => s.close(() => resolve()));
    s.closeIdleConnections = nodeIdleCloser;
    // Every request accepted before now is answered, and a connection ends
    // after the last of them: that one says so if it has not started, and the
    // settle hook in start() ends the socket once it finishes. Node itself
    // destroys a socket once a Connection: close response is flushed, which
    // resets it just as endAfterFlush explains, so that end lingers too.
    for (const socket of this.sockets) {
      const entry = this.pending.get(socket);
      if (!entry) {
        socket.destroy();
        continue;
      }
      socket.destroySoon = () => endAfterFlush(socket);
      if (!entry.last.headersSent) entry.last.setHeader('Connection', 'close');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, graceMs);
    });
    try {
      await Promise.race([closed.then(() => Promise.all(this.handling)), expired]);
    } finally {
      clearTimeout(timer);
      s.closeAllConnections();
      await closed;
      this.httpServer = undefined;
      this.closing = false;
    }
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
    // Registered before anything awaits: a client that leaves while its request
    // waits on the lane must not have it dispatched once its turn comes. A
    // response queued behind another on its connection never emits 'close', so
    // the socket is checked too.
    let gone = false;
    res.once('close', () => (gone = true));
    const socket = req.socket;
    const clientGone = () => gone || socket.destroyed;

    const auth = await this.opts.authenticate(req);
    if (!auth.ok) {
      for (const [k, v] of Object.entries(auth.headers ?? {})) res.setHeader(k, v);
      res.writeHead(auth.status, { 'Content-Type': 'application/json' });
      res.end(auth.body);
      this.log(`${auth.status} auth_failed path=/mcp`);
      return;
    }

    const sub = auth.sub ?? 'owner';

    // Tenant resolution (the seam EE fills): map the verified subject to ITS
    // server. Absent resolver = the one boot server for every subject.
    let target: ServerTarget | null = {
      server: this.opts.server,
      argShapeFor: this.opts.argShapeFor,
      strictArgs: this.opts.strictArgs,
      validationEnvelope: this.opts.validationEnvelope,
    };
    if (this.opts.resolveServer) {
      try {
        target = await this.opts.resolveServer({ sub });
      } catch {
        target = null;
      }
      if (!target) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'tenant_not_found', message: 'no tenant is provisioned for this subject' }));
        this.log('403 tenant_not_found path=/mcp');
        return;
      }
    }

    // Checked before the body read, so a refused request never buffers its body.
    const cap = this.opts.maxQueuedPerLane;
    if (cap === undefined) return this.admitted(req, res, target, sub, clientGone);
    const lane = target.server;
    const held = this.depth.get(lane) ?? 0;
    if (held >= cap) {
      res.setHeader('Retry-After', '1');
      this.fail(res, 429, 'lane_busy', 'too many requests are already queued for this server');
      this.log('429 lane_busy path=/mcp');
      return;
    }
    this.depth.set(lane, held + 1);
    try {
      await this.admitted(req, res, target, sub, clientGone);
    } finally {
      const left = (this.depth.get(lane) ?? 1) - 1;
      if (left > 0) this.depth.set(lane, left);
      else this.depth.delete(lane);
    }
  }

  private async admitted(
    req: IncomingMessage,
    res: ServerResponse,
    target: ServerTarget,
    sub: string,
    clientGone: () => boolean,
  ): Promise<void> {
    // Thread the verified subject to tool handlers: the Node transport forwards
    // req.auth verbatim as ctx.http.authInfo. Token/clientId stay empty — the
    // bearer value must not re-enter the dispatch path via handler context.
    (req as IncomingMessage & { auth?: AuthInfo }).auth = {
      token: '',
      clientId: '',
      scopes: ['mcp:use'],
      extra: { sub },
    };

    let body: unknown;
    try {
      body = await this.readJson(req);
    } catch (e) {
      return this.fail(res, 400, 'invalid_body', (e as Error).message);
    }
    const maxFrames = this.opts.maxBatchFrames ?? MAX_BATCH_FRAMES;
    if (Array.isArray(body) && body.length > maxFrames) {
      return this.fail(res, 400, 'batch_too_large', `a JSON-RPC batch may hold at most ${maxFrames} messages`);
    }

    // Host/Origin are enforced by the front guard above (uniformly for /mcp and
    // the mounted AS routes), so the SDK's own DNS-rebind guard is disabled: its
    // exact-Host match is stricter than the front guard and would 403 valid
    // Hosts (double enforcement, differing rules).
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: false,
    });
    // The shared McpServer holds exactly one connected transport at a time, so
    // connect + dispatch + DISCONNECT all run inside the mutex: the next request
    // can never hit "Already connected". The serialized section is guaranteed to
    // settle three ways — the handler finishes, the client disconnects (res
    // 'close'), or a dispatch deadline fires — so neither a client that holds the
    // connection open nor a hung upstream can wedge the lock. The transport is
    // closed in a finally (which resets server._transport) before the lock
    // releases. (A shared initialized-state persists across stateless requests;
    // benign for the single-owner design.)
    const deadlineMs = this.opts.dispatchTimeoutMs ?? DISPATCH_TIMEOUT_DEFAULT;
    // The lock lane is the SERVER identity, never the subject: two subjects
    // reaching one server (the boot server, or a resolver mapping several
    // subjects to one) would otherwise race it through the connect gap.
    const { server: mcpServer, argShapeFor, strictArgs, validationEnvelope } = target;
    await this.serializeFor(mcpServer, async () => {
      if (clientGone()) {
        this.log('499 client_gone path=/mcp');
        return;
      }
      const disconnected = new Promise<'closed'>((resolve) => res.once('close', () => resolve('closed')));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), deadlineMs);
        timer.unref?.();
      });
      // Same composition as the stdio leg: the envelope rewrite is innermost,
      // so the tap above it still classifies the original validation prose.
      const enveloped = withValidationEnvelope(transport, validationEnvelope ?? {});
      const tapped = this.opts.metricsTap ? this.opts.metricsTap(enveloped) : enveloped;
      await mcpServer.connect(
        argShapeFor || strictArgs
          ? withArgNormalization(tapped, argShapeFor ?? (() => undefined), this.opts.log, this.opts.onArgRename, strictArgs)
          : tapped,
      );
      // Reflect the dispatch into a non-rejecting arm: if the deadline wins the
      // race, an orphaned handler settling later must not surface as an unhandled
      // rejection — but a genuine dispatch error still propagates (rethrown below).
      let dispatchErr: unknown;
      const dispatchArm = transport
        .handleRequest(req, res, body)
        .then(() => 'done' as const, (e) => {
          dispatchErr = e;
          return 'error' as const;
        });
      try {
        const outcome = await Promise.race([dispatchArm, disconnected, timedOut]);
        if (outcome === 'error') throw dispatchErr;
        if (outcome === 'timeout') {
          this.log('504 dispatch_timeout path=/mcp');
          if (!res.headersSent) {
            res.writeHead(504, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'dispatch_timeout', message: 'the handler exceeded the dispatch deadline' }));
          } else {
            res.destroy();
          }
        } else if (outcome === 'done') {
          // Success path: close the observability gap (failures already log; a
          // completed dispatch logged nothing). Method only — no params, no PII.
          this.log(`200 /mcp method=${jsonRpcMethod(body)}`);
        }
      } finally {
        if (timer) clearTimeout(timer);
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
      // A client that left while the request was authenticated or resolved has
      // already destroyed it, and no 'end' or 'error' would ever follow.
      if (req.destroyed) return reject(new Error('request aborted'));
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
    // A response already started cannot become an error one; cutting it tells
    // the client it is incomplete.
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error, message }));
  }
}
