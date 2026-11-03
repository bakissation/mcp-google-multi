// Streamable HTTP transport host: node:http server, route table, front guard,
// and stateless per-request /mcp dispatch. See docs/internals.md.
import type { McpServer, Transport, AuthInfo } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { Socket } from 'node:net';
import type { HttpConfig } from './http-config.js';
import { withArgNormalization, type ArgShape, type StrictArgOptions, withValidationEnvelope, type ValidationEnvelopeOptions } from './arg-normalize.js';
import { logSafe } from './trim.js';
// A host wrapping the log callbacks it hands core needs this, and trim has no package export.
export { logSafe } from './trim.js';
export type AuthOutcome =
  | { ok: true; sub?: string }
  | { ok: false; status: number; body: string; headers?: Record<string, string> };

/** Bearer / owner check for POST /mcp. Default = loopback-owner; the AS swaps in JWT verify. */
export type Authenticator = (req: IncomingMessage) => AuthOutcome | Promise<AuthOutcome>;

/** A mounted extra route (the AS endpoints). Return true if it wrote a response. */
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
  /** The ONE McpServer + registry built at boot (never per request). */
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
  resolveServer?: (
    claims: { sub: string },
  ) =>
    | Promise<ServerTarget | null | { refused: { error: string; message: string } }>
    | ServerTarget
    | null
    | { refused: { error: string; message: string } };
  /** Extra routes keyed by exact pathname (AS endpoints mount here). */
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
// serialize() lock forever; generous by default so slow-but-valid calls still finish.
const DISPATCH_TIMEOUT_DEFAULT = 120_000;
// Without a cap, one body multiplies per-call work by however many
// JSON-RPC frames the SDK's synchronous batch screening finds in it.
const MAX_BATCH_FRAMES = 16;
const DEFAULT_MAX_BODY_BYTES = 4_000_000;

// A refusal's body reaches the wire verbatim, so it's validated: no new slug
// literal enters core, and an overlong message can't leak an operator path/env var.
const REFUSAL_SLUG_RE = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_REFUSAL_MESSAGE_CHARS = 300;
// C0/C1 controls, format chars (bidi overrides, zero-width joiners) and
// line/paragraph separators; ordinary non-ASCII letters stay allowed.
const NON_PRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function isValidRefusal(r: { error: unknown; message: unknown }): boolean {
  return (
    typeof r.error === 'string' &&
    REFUSAL_SLUG_RE.test(r.error) &&
    typeof r.message === 'string' &&
    r.message.length > 0 &&
    r.message.length <= MAX_REFUSAL_MESSAGE_CHARS &&
    !NON_PRINTABLE_RE.test(r.message)
  );
}

export function parseOwnerEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.MCP_OWNER_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Front guard: an Origin, if present, must be allowlisted; a Host must be
 * allowlisted. Absent Origin passes (native/CLI/backend clients — the claude.ai
 * connector calls /mcp server-to-server with no Origin). */
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

const METHOD_NAME = /^[A-Za-z0-9_./$-]{1,64}$/;
const BATCH_METHODS_SHOWN = 4;

/** JSON-RPC method name(s) for an observability log line: no params, no PII.
 * The method is the caller's: anything not shaped like a method name, which
 * includes a value whose String() throws, is logged as `<invalid>`. */
export function jsonRpcMethod(body: unknown): string {
  const one = (b: unknown): string | undefined => {
    if (!b || typeof b !== 'object' || !('method' in b)) return undefined;
    const m = (b as { method: unknown }).method;
    return typeof m === 'string' && METHOD_NAME.test(m) ? m : '<invalid>';
  };
  if (!Array.isArray(body)) return one(body) ?? 'unknown';
  const names = body.map(one).filter((n): n is string => n !== undefined);
  if (names.length === 0) return 'batch';
  const rest = names.length - BATCH_METHODS_SHOWN;
  return rest > 0 ? `${names.slice(0, BATCH_METHODS_SHOWN).join(',')},+${rest}` : names.join(',');
}


/** setTimeout fires at once for a delay above this, so a longer grace would
 * cut every connection immediately. */
const MAX_GRACE_MS = 2 ** 31 - 1;

// A lingering close (ends the socket, never destroys it); see docs/internals.md (Graceful close).
function endAfterFlush(socket: Socket): void {
  if (socket.destroyed || socket.writableEnded) return;
  // Disarm the keep-alive timer Node arms on finish, or it destroys the
  // socket ~6s later and cuts a slow reader's unread tail the same way an early destroy does.
  socket.setTimeout(0);
  socket.end();
}

// Stops reading for good so TCP flow control stops the client, instead of
// piling up a flood pipelined behind a held response; see docs/internals.md (Graceful close).
function stopReading(socket: Socket): void {
  socket.pause();
  socket.resume = () => socket;
}

/** How long a refused oversized request may keep its socket open so the client
 * can read the refusal before the connection is cut. */
const REFUSAL_LINGER_MS = 5000;

// Refuses a request whose body is not going to be read. Closing the socket
// with unread input makes the kernel reset the connection, and on Windows the
// reset also drops the answer still in flight, so the client sees ECONNRESET
// instead of the 413. Stop reading (TCP flow control then stops the client),
// end the socket once the answer is flushed, and cut it after a short grace.
function lingerAfterRefusal(socket: Socket): void {
  if (socket.destroyed) return;
  stopReading(socket);
  socket.destroySoon = () => endAfterFlush(socket);
  const timer = setTimeout(() => socket.destroy(), REFUSAL_LINGER_MS);
  timer.unref();
  socket.once('close', () => clearTimeout(timer));
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
  // Per-server dispatch mutex; see docs/internals.md.
  private readonly locks = new Map<McpServer, Promise<unknown>>();
  // Requests holding a lane slot, per server; used only with maxQueuedPerLane.
  private readonly depth = new Map<McpServer, number>();
  // What a graceful close waits on: open sockets and every handle() not yet
  // settled; see docs/internals.md (Graceful close).
  private readonly sockets = new Set<Socket>();
  private readonly pending = new Map<Socket, { count: number; last: ServerResponse }>();
  // Sockets that have accepted a request: nothing pending means the last
  // response finished writing, but its tail can still sit in kernel buffers.
  private readonly served = new WeakSet<Socket>();
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
    // An idle lane drops out of the map; the identity check below skips a
    // later request that already replaced this tail, so it never frees a live lane.
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
      // Once closing, a request arriving now is never handled (RFC 9112 §9.6)
      // and its body is left unread.
      if (this.closing) {
        stopReading(socket);
        return;
      }
      this.served.add(socket);
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
      // Never rejects (close() waits on it); the thrown message can name
      // server paths, so it goes only to the host's log.
      const done = this.handle(req, res)
        .catch((e) => {
          try {
            this.fail(res, 500, 'internal_error', 'internal error');
          } finally {
            // A throwing log must not reach the destroy below: the answer is sent.
            try {
              this.log(`500 internal_error path=${pathOf(req)}: ${e instanceof Error ? logSafe(e.message, 200) : 'non-Error throw'}`);
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
    // Starting over would arm a second grace, and a shorter one would cut
    // what the first still lets finish.
    this.graceful ??= this.closeGracefully(s, graceMs).finally(() => (this.graceful = undefined));
    return this.graceful;
  }

  private async closeGracefully(s: Server, graceMs: number): Promise<void> {
    this.closing = true;
    // Node's close() also destroys idle connections, which would cut short a
    // large response still flushing; idle sockets are closed below instead.
    const nodeIdleCloser = s.closeIdleConnections;
    s.closeIdleConnections = () => undefined;
    const closed = new Promise<void>((resolve) => s.close(() => resolve()));
    s.closeIdleConnections = nodeIdleCloser;
    // Socket bookkeeping below; see docs/internals.md (Graceful close).
    for (const socket of this.sockets) {
      const entry = this.pending.get(socket);
      if (!entry && !this.served.has(socket)) {
        socket.destroy();
        continue;
      }
      socket.destroySoon = () => endAfterFlush(socket);
      if (!entry) endAfterFlush(socket);
      else if (!entry.last.headersSent) entry.last.setHeader('Connection', 'close');
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
      this.log(`403 host_rejected host=${logSafe(req.headers.host ?? '', 64)}`);
      this.fail(res, 403, 'host_rejected', 'Host not allowed (DNS-rebinding guard).');
      return false;
    }
    if (!originAllowed(req.headers.origin, allowedOrigins)) {
      this.log(`403 origin_rejected origin=${logSafe(req.headers.origin ?? '', 64)}`);
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
    // Registered before anything awaits (client-gone skip); see docs/internals.md.
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

    // Tenant resolution (a multi-tenant host fills this seam): map the
    // verified subject to ITS server. Absent resolver = the one boot server for every subject.
    let target: ServerTarget | null = {
      server: this.opts.server,
      argShapeFor: this.opts.argShapeFor,
      strictArgs: this.opts.strictArgs,
      validationEnvelope: this.opts.validationEnvelope,
    };
    if (this.opts.resolveServer) {
      let resolved: ServerTarget | null | { refused: { error: string; message: string } };
      try {
        resolved = await this.opts.resolveServer({ sub });
      } catch {
        resolved = null;
      }
      if (resolved && 'refused' in resolved) {
        const { refused } = resolved;
        if (isValidRefusal(refused)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: refused.error, message: refused.message }));
          this.log(`403 ${refused.error} path=/mcp`);
          return;
        }
        // An invalid shape falls through to today's exact answer rather than
        // forwarding something unvalidated.
        resolved = null;
      }
      target = resolved;
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
    // Thread the verified subject to tool handlers via ctx.http.authInfo;
    // token/clientId stay empty so the bearer value never re-enters the dispatch path.
    (req as IncomingMessage & { auth?: AuthInfo }).auth = {
      token: '',
      clientId: '',
      scopes: ['mcp:use'],
      extra: { sub },
    };

    // A declared length over the cap is refused before a single byte is read;
    // chunked bodies without a length are still bounded while streaming.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > (this.opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES)) {
      this.log('413 payload_too_large path=/mcp');
      // Answer first and let the client read it: destroying the socket with
      // the body unread would reset the client before it can see the 413.
      lingerAfterRefusal(req.socket);
      res.setHeader('Connection', 'close');
      this.fail(res, 413, 'payload_too_large', 'request body too large');
      return;
    }

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

    // The SDK's own DNS-rebind guard is disabled: Host/Origin are already
    // enforced above, and its stricter exact-Host match would 403 valid Hosts.
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: false,
    });
    // connect + dispatch + disconnect run inside the per-server mutex, keyed
    // on the server identity, never the subject; see docs/internals.md.
    const deadlineMs = this.opts.dispatchTimeoutMs ?? DISPATCH_TIMEOUT_DEFAULT;
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
      // Envelope rewrite innermost, as on stdio; see docs/internals.md (Argument normalization).
      const enveloped = withValidationEnvelope(transport, validationEnvelope ?? {});
      const tapped = this.opts.metricsTap ? this.opts.metricsTap(enveloped) : enveloped;
      await mcpServer.connect(
        argShapeFor || strictArgs
          ? withArgNormalization(tapped, argShapeFor ?? (() => undefined), this.opts.log, this.opts.onArgRename, strictArgs)
          : tapped,
      );
      // Non-rejecting arm: an orphaned handler settling after the deadline wins
      // must not surface as an unhandled rejection; a real error is rethrown below.
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
    // No secrets, no owner emails.
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
    const max = this.opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
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
