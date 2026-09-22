import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { withFileLock, atomicWriteFileSync } from './fs-atomic.js';

// Local usage metrics (metrics-feature-spec.md). Default OFF at every layer;
// when off, nothing here initializes and the dispatch chain carries no wrapper.
// Zero network egress is structural: this module's import set is a tested
// allowlist (fs/path/os/crypto/perf_hooks/fs-atomic), so egress code cannot
// even be expressed here. Every string persisted is a member of a server-owned
// closed vocabulary, matches a pinned shape regex, or is other/unknown_*/
// _overflow; free text is unrepresentable in the file format. No identity
// dimension of any kind: no aliases, hashes, emails, or exact account counts.

export const METRICS_DIR_NAME = 'metrics';
const FLUSH_MS = 60_000;
const RETRY_WINDOW_MS = 10 * 60_000;
const BIGRAM_GAP_MS = 5 * 60_000;
const BIGRAM_CAP = 1_500;
const ERR_SLUG_CAP = 32;
const VALIDATION_CAP = 200;
const ESCAPE_CAP = 500;
const EVENTS_ROTATE_BYTES = 4 * 1024 * 1024;
const RETENTION_DAYS = 180;
const WRITE_FAILURE_LIMIT = 3;

const LAT_BOUNDS = [100, 250, 500, 1000, 2500, 5000, 10000, 30000] as const;
const CHARS_BOUNDS = [64, 256, 1024, 4096, 16384, 65536] as const;

// methodId backstop shape gate: even a tampered discovery cache cannot turn
// arbitrary strings into recorded values (spec section 1).
const METHOD_ID_RE = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/;
const METHOD_ID_MAX = 128;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
// Declared argument keys are camelCase identifiers, some dotted
// (groupKey.id, debugOptions.enableDebugging).
const ARG_KEY_RE = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;

/** Union of every `error:` slug literal emitted anywhere in src/ (kept honest
 * by a set-equality grep test). Anything outside buckets to `other`. */
export const KNOWN_ERROR_SLUGS: ReadonlySet<string> = new Set([
  'E_ALIAS_EXISTS', 'E_CIMD_INVALID', 'E_ENV_ACCOUNTS_MODE', 'E_MCP_TOKEN_INVALID',
  'E_NO_DEFAULT_ACCOUNT', 'E_UNKNOWN_BUNDLE', 'E_VALIDATION', 'ambiguous',
  'api_not_enabled', 'auth_required', 'bad_request', 'binary', 'binary_unsupported',
  'confirmation_declined', 'diagnose_failed', 'discovery_unavailable', 'dispatch_timeout',
  'elicitation_unsupported', 'fanout_failed', 'forbidden',
  'insufficient_scope', 'internal', 'invalid_client', 'invalid_client_metadata',
  'invalid_grant', 'invalid_params', 'invalid_query', 'invalid_request',
  'invalid_scope', 'network_error', 'not_found', 'rate_limited',
  'reauth_required', 'recipient_not_allowed', 'too_large', 'toolset_disabled', 'unknown_api',
  'unknown_argument', 'unknown_method', 'unsupported_grant_type', 'unsupported_type',
  'untrusted_host', 'upstream_error', 'validation_error', 'write_disabled',
]);

const RPC_CODES = new Set([-32700, -32600, -32601, -32603]);

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(
    env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'),
    'mcp-google-multi',
  );
}

export function latBucket(ms: number): string {
  for (const b of LAT_BOUNDS) if (ms <= b) return `le${b}`;
  return 'gt30000';
}

export function charsBucket(n: number): string {
  for (const b of CHARS_BOUNDS) if (n <= b) return `le${b}`;
  return 'gt65536';
}

export function fanBucket(width: number): string | undefined {
  if (width <= 1) return undefined;
  if (width === 2) return 'w2';
  if (width <= 4) return 'w3to4';
  return 'w5plus';
}

export type MetricsSource =
  | { kind: 'default' }
  | { kind: 'config' }
  | { kind: 'process-env' }
  | { kind: 'env-file'; file: string };

export interface UsageMetricsState {
  enabled: boolean;
  source: MetricsSource;
  /** exactly one stderr warning on a malformed non-empty env value (fail-closed) */
  warning?: string;
}

const ON = new Set(['on', '1', 'true', 'yes']);
const OFF = new Set(['off', '0', 'false', 'no']);

/**
 * Fail-closed resolution (mirror of resolveDiscoveryMode's fail-open: here the
 * safe state is off). Env wins over config; empty env value = unset, silent;
 * any other value = one warning, off. `envFile` is the .env path that supplied
 * the variable when it did not come from the real process env (attribution
 * is computed by the caller; this module never reads env files).
 */
export function resolveUsageMetrics(
  env: NodeJS.ProcessEnv,
  configValue: boolean | undefined,
  envFile?: string,
): UsageMetricsState {
  const raw = env.GOOGLE_USAGE_METRICS;
  if (raw !== undefined && raw.trim() !== '') {
    const v = raw.trim().toLowerCase();
    const source: MetricsSource = envFile ? { kind: 'env-file', file: envFile } : { kind: 'process-env' };
    if (ON.has(v)) return { enabled: true, source };
    if (OFF.has(v)) return { enabled: false, source };
    return {
      enabled: false,
      source: { kind: 'default' },
      warning: `GOOGLE_USAGE_METRICS="${raw}" is not a valid value (on|1|true|yes / off|0|false|no); local usage metrics stay OFF\n`,
    };
  }
  if (configValue === true) return { enabled: true, source: { kind: 'config' } };
  return { enabled: false, source: { kind: 'default' } };
}

export function sourceLabel(source: MetricsSource): string {
  switch (source.kind) {
    case 'config': return '(config)';
    case 'process-env': return '(process env)';
    case 'env-file': return `(env file: ${source.file})`;
    default: return '(default)';
  }
}

export interface ToolEntryInfo {
  name: string;
  service: string;
  meta: boolean;
  generated: boolean;
}

interface ToolAgg {
  n: number;
  err: Record<string, number>;
  hint: number;
  lat: Record<string, number>;
  fanout?: { calls: number } & Record<string, number>;
  argfix?: number;
  /** undeclared keys, counted by the DECLARED key they resolve to */
  argdrop?: Record<string, number>;
}

export interface DayAgg {
  v: 1;
  day: string;
  boots: Record<string, number>;
  node: string;
  calls: number;
  tools: Record<string, ToolAgg>;
  hints: Record<string, { hinted: number; unhinted: number }>;
  retries: Record<string, { hintedOk: number; hintedFail: number; unhintedOk: number; unhintedFail: number }>;
  escape: { methods: Record<string, number>; _overflow: number; unknown_method: number; apis_searched: Record<string, number>; unknown_api: number };
  validation: Record<string, number>;
  rpc: Record<string, number>;
  bigrams: Record<string, number>;
}

export interface InitOptions {
  dir?: string;
  version: string;
  mode: string;
  transport: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  monotonic?: () => number;
  log?: (line: string) => void;
}

function emptyDay(day: string): DayAgg {
  return {
    v: 1, day, boots: {}, node: process.version, calls: 0, tools: {},
    hints: {}, retries: {},
    escape: { methods: {}, _overflow: 0, unknown_method: 0, apis_searched: {}, unknown_api: 0 },
    validation: {}, rpc: {}, bigrams: {},
  };
}

function addInto(target: Record<string, number>, key: string, by = 1): void {
  target[key] = (target[key] ?? 0) + by;
}

/** Deep-add b into a for the DayAgg shape (numbers add, maps union). */
export function mergeDay(a: DayAgg, b: DayAgg): DayAgg {
  const num = (x: number | undefined, y: number | undefined) => (x ?? 0) + (y ?? 0);
  const map = (x: Record<string, number> = {}, y: Record<string, number> = {}) => {
    const out: Record<string, number> = { ...x };
    for (const [k, v] of Object.entries(y)) out[k] = (out[k] ?? 0) + v;
    return out;
  };
  const out = emptyDay(a.day);
  out.node = b.node || a.node;
  out.boots = map(a.boots, b.boots);
  out.calls = num(a.calls, b.calls);
  const toolNames = new Set([...Object.keys(a.tools), ...Object.keys(b.tools)]);
  for (const name of toolNames) {
    const x = a.tools[name]; const y = b.tools[name];
    const t: ToolAgg = { n: num(x?.n, y?.n), err: map(x?.err, y?.err), hint: num(x?.hint, y?.hint), lat: map(x?.lat, y?.lat) };
    if (x?.fanout || y?.fanout) t.fanout = map(x?.fanout as Record<string, number>, y?.fanout as Record<string, number>) as ToolAgg['fanout'];
    const argfix = num(x?.argfix, y?.argfix);
    if (argfix > 0) t.argfix = argfix;
    if (x?.argdrop || y?.argdrop) t.argdrop = map(x?.argdrop, y?.argdrop);
    out.tools[name] = t;
  }
  const slugSet = new Set([...Object.keys(a.hints), ...Object.keys(b.hints)]);
  for (const s of slugSet) {
    out.hints[s] = {
      hinted: num(a.hints[s]?.hinted, b.hints[s]?.hinted),
      unhinted: num(a.hints[s]?.unhinted, b.hints[s]?.unhinted),
    };
  }
  const retrySet = new Set([...Object.keys(a.retries), ...Object.keys(b.retries)]);
  for (const s of retrySet) {
    out.retries[s] = {
      hintedOk: num(a.retries[s]?.hintedOk, b.retries[s]?.hintedOk),
      hintedFail: num(a.retries[s]?.hintedFail, b.retries[s]?.hintedFail),
      unhintedOk: num(a.retries[s]?.unhintedOk, b.retries[s]?.unhintedOk),
      unhintedFail: num(a.retries[s]?.unhintedFail, b.retries[s]?.unhintedFail),
    };
  }
  out.escape = {
    methods: map(a.escape.methods, b.escape.methods),
    _overflow: num(a.escape._overflow, b.escape._overflow),
    unknown_method: num(a.escape.unknown_method, b.escape.unknown_method),
    apis_searched: map(a.escape.apis_searched, b.escape.apis_searched),
    unknown_api: num(a.escape.unknown_api, b.escape.unknown_api),
  };
  out.validation = map(a.validation, b.validation);
  out.rpc = map(a.rpc, b.rpc);
  out.bigrams = map(a.bigrams, b.bigrams);
  return out;
}

/** Cap open maps at write time (the file may never exceed the caps). */
function applyCaps(day: DayAgg): DayAgg {
  const cap = (m: Record<string, number>, limit: number, overflowInto?: (n: number) => void) => {
    const entries = Object.entries(m);
    if (entries.length <= limit) return m;
    entries.sort((x, y) => y[1] - x[1]);
    const kept = Object.fromEntries(entries.slice(0, limit));
    const dropped = entries.slice(limit).reduce((s, [, v]) => s + v, 0);
    if (overflowInto) overflowInto(dropped);
    else kept.other = (kept.other ?? 0) + dropped;
    return kept;
  };
  for (const t of Object.values(day.tools)) {
    t.err = cap(t.err, ERR_SLUG_CAP);
    if (t.argdrop) t.argdrop = cap(t.argdrop, ERR_SLUG_CAP);
  }
  // Bounded by the registered tool set via the tap's membership test, but
  // capped anyway: this map is the only one fed by a wire-supplied key.
  day.validation = cap(day.validation, VALIDATION_CAP);
  day.escape.methods = cap(day.escape.methods, ESCAPE_CAP, (n) => { day.escape._overflow += n; });
  day.bigrams = cap(day.bigrams, BIGRAM_CAP, (n) => { day.bigrams._overflow = (day.bigrams._overflow ?? 0) + n; });
  return day;
}

export class Metrics {
  private readonly dir: string;
  private readonly aggDir: string;
  private readonly eventsFile: string;
  private readonly now: () => number;
  private readonly mono: () => number;
  private readonly log: (line: string) => void;
  private readonly bootKey: string;
  private readonly bootId = randomBytes(3).toString('hex');
  private seq = 0;
  private deltas: DayAgg;
  private events: string[] = [];
  private lastError = new Map<string, { slug: string; hinted: boolean; at: number }>();
  private lastTool: { name: string; at: number } | undefined;
  private pendingMid: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;
  private failures = 0;
  private disabled = false;

  constructor(opts: InitOptions) {
    this.dir = opts.dir ?? path.join(stateDir(opts.env), METRICS_DIR_NAME);
    this.aggDir = path.join(this.dir, 'agg');
    this.eventsFile = path.join(this.dir, 'events.jsonl');
    this.now = opts.now ?? Date.now;
    this.mono = opts.monotonic ?? (() => performance.now());
    this.log = opts.log ?? ((l) => process.stderr.write(l));
    this.bootKey = `${opts.version}/${opts.mode}/${opts.transport}`;
    this.deltas = emptyDay(this.day());
    this.deltas.boots[this.bootKey] = 1;
    this.dirty = true;
    this.initStorage();
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    this.timer.unref?.();
  }

  private day(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  private initStorage(): void {
    try {
      const existed = fs.existsSync(this.dir);
      fs.mkdirSync(this.aggDir, { recursive: true, mode: 0o700 });
      if (existed) {
        const mode = fs.statSync(this.dir).mode & 0o777;
        if ((mode & 0o077) !== 0) {
          this.log(`local usage metrics: ${this.dir} has mode ${mode.toString(8)} (wider than 0700); not changing it, but the files record activity\n`);
        }
      }
      this.pruneAggs();
      this.pruneEventAge(this.eventsFile);
    } catch (e) {
      this.log(`local usage metrics: init failed (${(e as Error).message}); disabled for this process\n`);
      this.disabled = true;
    }
  }

  private pruneAggs(): void {
    const cutoff = this.day2ms(this.day()) - RETENTION_DAYS * 86_400_000;
    for (const f of fs.readdirSync(this.aggDir)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
      if (m && this.day2ms(m[1]) < cutoff) {
        try { fs.rmSync(path.join(this.aggDir, f)); } catch { /* prune is best-effort */ }
      }
    }
  }

  private day2ms(day: string): number {
    return Date.parse(`${day}T00:00:00Z`);
  }

  private pruneEventAge(file: string): void {
    if (!fs.existsSync(file)) return;
    const cutoff = this.now() - RETENTION_DAYS * 86_400_000;
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    const kept = lines.filter((l) => {
      if (!l.trim()) return false;
      try {
        const ts = (JSON.parse(l) as { ts?: string }).ts;
        return typeof ts === 'string' && Date.parse(ts) >= cutoff;
      } catch {
        return false; // torn or corrupt line: drop
      }
    });
    if (kept.length !== lines.filter((l) => l.trim()).length) {
      atomicWriteFileSync(file, kept.join('\n') + (kept.length ? '\n' : ''));
    }
  }

  /** Outermost dispatch wrapper; a throw inside recording never affects the call. */
  wrap<A extends unknown[], R>(
    entry: ToolEntryInfo,
    handler: (...args: A) => Promise<R> | R,
    widthOf?: (args: unknown) => number,
  ): (...args: A) => Promise<R> {
    return async (...args: A) => {
      const started = this.mono();
      const result = await handler(...args);
      try {
        this.record(entry, args[0], result, this.mono() - started, widthOf);
      } catch { /* metrics may never fail a tool call */ }
      return result;
    };
  }

  private record(entry: ToolEntryInfo, firstArg: unknown, result: unknown, ms: number, widthOf?: (a: unknown) => number): void {
    if (this.disabled) return;
    this.rolloverIfNeeded();
    const r = result as { isError?: boolean; content?: { type?: string; text?: string }[] } | undefined;
    const ok = !r?.isError;
    let slug: string | undefined;
    let hinted: boolean | undefined;
    if (!ok) {
      try {
        const first = r?.content?.[0]?.text;
        if (typeof first === 'string' && first.length < 65_536) {
          const env = JSON.parse(first) as { error?: unknown; hint?: unknown };
          if (typeof env.error === 'string') slug = KNOWN_ERROR_SLUGS.has(env.error) ? env.error : 'other';
          hinted = typeof env.hint === 'string' && env.hint.length > 0;
        }
      } catch { slug = 'other'; }
      slug ??= 'other';
    }
    const chars = (r?.content ?? []).reduce((s, c) => s + (typeof c.text === 'string' ? c.text.length : 0), 0);
    let width = 1;
    if (widthOf) { try { width = widthOf(firstArg); } catch { width = 1; } }
    const fan = fanBucket(width);

    const t = (this.deltas.tools[entry.name] ??= { n: 0, err: {}, hint: 0, lat: {} });
    t.n += 1;
    this.deltas.calls += 1;
    addInto(t.lat, latBucket(ms));
    if (slug) {
      addInto(t.err, slug);
      if (hinted) t.hint += 1;
      const h = (this.deltas.hints[slug] ??= { hinted: 0, unhinted: 0 });
      if (hinted) h.hinted += 1;
      else h.unhinted += 1;
    }
    if (fan) {
      const f = (t.fanout ??= { calls: 0 });
      f.calls += 1;
      addInto(f as unknown as Record<string, number>, fan);
    }

    // retry self-correction chain (spec section 1): in-memory only.
    const nowM = this.mono();
    const prev = this.lastError.get(entry.name);
    if (prev && nowM - prev.at <= RETRY_WINDOW_MS) {
      const rr = (this.deltas.retries[prev.slug] ??= { hintedOk: 0, hintedFail: 0, unhintedOk: 0, unhintedFail: 0 });
      const key = `${prev.hinted ? 'hinted' : 'unhinted'}${ok ? 'Ok' : 'Fail'}` as keyof typeof rr;
      rr[key] += 1;
      this.lastError.delete(entry.name);
    }
    if (!ok && slug) this.lastError.set(entry.name, { slug, hinted: hinted === true, at: nowM });

    // bigrams: ordered pairs within the process, 5-minute gap breaks the chain.
    if (this.lastTool && nowM - this.lastTool.at <= BIGRAM_GAP_MS) {
      addInto(this.deltas.bigrams, `${this.lastTool.name}>${entry.name}`);
    }
    this.lastTool = { name: entry.name, at: nowM };

    const event: Record<string, unknown> = {
      ts: new Date(this.now()).toISOString().slice(0, 16) + ':00Z',
      boot: this.bootId,
      seq: this.seq++,
      tool: entry.name,
      ok,
      ms: Math.round(ms),
      chars: charsBucket(chars),
      src: 'handler',
    };
    if (slug) event.err = slug;
    if (hinted !== undefined) event.hint = hinted;
    if (fan) event.fan = fan;
    // mid: set mid-dispatch by recordEscapeMethod, attached to the escape
    // call's own event line (per-event field, never a synthetic event).
    if (entry.name === 'google_api_call' && this.pendingMid) {
      event.mid = this.pendingMid;
      this.pendingMid = undefined;
    }
    this.events.push(JSON.stringify(event));
    this.dirty = true;
  }

  /** Escape hatch: only the RESOLVED methodId (double-gated) or a miss. */
  recordEscapeMethod(idOrNull: string | null): void {
    try {
      this.rolloverIfNeeded();
      if (idOrNull === null) {
        this.deltas.escape.unknown_method += 1;
      } else if (idOrNull.length <= METHOD_ID_MAX && METHOD_ID_RE.test(idOrNull)) {
        addInto(this.deltas.escape.methods, idOrNull);
        this.pendingMid = idOrNull;
      }
      this.dirty = true;
    } catch { /* never throws outward */ }
  }

  /** Search instrument: post-resolution SUPPORTED_APIS keys, or null on failure. */
  recordSearchApi(resolvedApis: string[] | null): void {
    try {
      this.rolloverIfNeeded();
      if (resolvedApis === null) this.deltas.escape.unknown_api += 1;
      else for (const k of resolvedApis) addInto(this.deltas.escape.apis_searched, k);
      this.dirty = true;
    } catch { /* never throws outward */ }
  }

  /**
   * Undeclared argument keys seen on a call. `resolvedKeys` carries only the
   * SUGGESTED (declared) key or the literal `_unmatched`, never the caller's
   * key, so the closed-vocabulary guarantee holds: a client cannot write an
   * invented string to disk through this path.
   */
  recordArgDrop(tool: string, resolvedKeys: string[]): void {
    try {
      this.rolloverIfNeeded();
      if (!TOOL_NAME_RE.test(tool)) return;
      const t = (this.deltas.tools[tool] ??= { n: 0, err: {}, hint: 0, lat: {} });
      const map = (t.argdrop ??= {});
      for (const key of resolvedKeys) {
        if (key !== '_unmatched' && !ARG_KEY_RE.test(key)) continue;
        addInto(map, key);
      }
      this.dirty = true;
    } catch { /* never throws outward */ }
  }

  recordArgFix(tool: string, by = 1): void {
    try {
      this.rolloverIfNeeded();
      if (!TOOL_NAME_RE.test(tool)) return;
      const t = (this.deltas.tools[tool] ??= { n: 0, err: {}, hint: 0, lat: {} });
      t.argfix = (t.argfix ?? 0) + by;
      this.dirty = true;
    } catch { /* never throws outward */ }
  }

  /** Protocol-level failures (no handler ran); wired by the transport tap. */
  recordRpc(kind: 'schema_validation' | 'tool_not_found' | number, tool?: string): void {
    try {
      this.rolloverIfNeeded();
      if (kind === 'schema_validation') {
        // The tap's name came off the wire; the shape gate keeps a weird
        // -32602 from writing free text (registered names always pass).
        if (tool && TOOL_NAME_RE.test(tool)) addInto(this.deltas.validation, tool);
      } else if (kind === 'tool_not_found') {
        addInto(this.deltas.rpc, 'tool_not_found');
      } else {
        addInto(this.deltas.rpc, RPC_CODES.has(kind) ? `rpc_error_${kind}` : 'rpc_error_other');
      }
      this.events.push(JSON.stringify({
        ts: new Date(this.now()).toISOString().slice(0, 16) + ':00Z',
        boot: this.bootId, seq: this.seq++,
        tool: tool && TOOL_NAME_RE.test(tool) ? tool : 'other',
        ok: false, ms: 0, chars: 'le64', src: 'rpc',
      }));
      this.dirty = true;
    } catch { /* never throws outward */ }
  }

  private rolloverIfNeeded(): void {
    const today = this.day();
    if (this.deltas.day !== today) {
      this.flush();
      this.deltas = emptyDay(today);
      this.pruneAggs();
      this.dirty = false;
    }
  }

  /** Merge deltas into the day file under lock; append buffered events. */
  flush(): void {
    if (!this.dirty || this.disabled) return;
    const deltas = this.deltas;
    const events = this.events;
    try {
      const file = path.join(this.aggDir, `${deltas.day}.json`);
      withFileLock(file, () => {
        let current = emptyDay(deltas.day);
        try {
          const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8')) as DayAgg;
          if (onDisk && onDisk.v === 1 && onDisk.day === deltas.day) current = onDisk;
        } catch {
          if (fs.existsSync(file)) this.log(`local usage metrics: unreadable day file ${file}; starting fresh\n`);
        }
        atomicWriteFileSync(file, JSON.stringify(applyCaps(mergeDay(current, deltas))));
      });
      if (events.length > 0) {
        fs.appendFileSync(this.eventsFile, events.join('\n') + '\n', { mode: 0o600 });
        this.rotateIfNeeded();
      }
      this.deltas = emptyDay(deltas.day);
      this.events = [];
      this.dirty = false;
      this.failures = 0;
    } catch (e) {
      this.failures += 1;
      if (this.failures >= WRITE_FAILURE_LIMIT) {
        this.disabled = true;
        if (this.timer) clearInterval(this.timer);
        this.log(`local usage metrics: ${WRITE_FAILURE_LIMIT} consecutive write failures (${(e as Error).message}); disabled for this process\n`);
      }
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (fs.statSync(this.eventsFile).size < EVENTS_ROTATE_BYTES) return;
      this.pruneEventAge(this.eventsFile);
      if (fs.statSync(this.eventsFile).size < EVENTS_ROTATE_BYTES) return;
      fs.renameSync(this.eventsFile, path.join(this.dir, 'events.1.jsonl'));
    } catch { /* rotation is best-effort */ }
  }

  /** Best-effort synchronous flush for shutdown paths. */
  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.flush();
  }

  /** For the doctor/diagnose status line. */
  statusLine(): string {
    try {
      const files = [
        ...fs.readdirSync(this.aggDir).map((f) => path.join(this.aggDir, f)),
        this.eventsFile, path.join(this.dir, 'events.1.jsonl'),
      ].filter((f) => fs.existsSync(f));
      const bytes = files.reduce((s, f) => s + fs.statSync(f).size, 0);
      return `${this.dir} (${files.length} files, ${Math.round(bytes / 1024)} KB)`;
    } catch {
      return this.dir;
    }
  }
}

/** Read-only description of the metrics dir for doctor/diagnose status lines
 * (never creates anything; safe to call with the feature off). */
export function describeMetricsDir(env: NodeJS.ProcessEnv = process.env): { dir: string; files: number; kb: number } {
  const dir = env.USAGE_METRICS_PATH ?? path.join(stateDir(env), METRICS_DIR_NAME);
  let files = 0;
  let bytes = 0;
  try {
    const candidates = [
      ...fs.readdirSync(path.join(dir, 'agg')).map((f) => path.join(dir, 'agg', f)),
      path.join(dir, 'events.jsonl'),
      path.join(dir, 'events.1.jsonl'),
    ];
    for (const f of candidates) {
      try {
        bytes += fs.statSync(f).size;
        files += 1;
      } catch { /* absent */ }
    }
  } catch { /* dir absent: zeros */ }
  return { dir, files, kb: Math.round(bytes / 1024) };
}

/**
 * null when off: no directory, no file, no timer, nothing initializes; setting
 * USAGE_METRICS_PATH alone never enables anything and never creates anything.
 */
export function initUsageMetrics(state: UsageMetricsState, opts: InitOptions): Metrics | null {
  if (!state.enabled) return null;
  return new Metrics({
    ...opts,
    dir: opts.dir ?? (opts.env ?? process.env).USAGE_METRICS_PATH ?? undefined,
  });
}
