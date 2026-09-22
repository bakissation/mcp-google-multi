import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import {
  Metrics,
  KNOWN_ERROR_SLUGS,
  charsBucket,
  fanBucket,
  initUsageMetrics,
  latBucket,
  resolveUsageMetrics,
  sourceLabel,
} from '../src/usage-metrics.js';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-metrics-'));
  dirs.push(d);
  return path.join(d, 'metrics');
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function make(dir: string, opts: { now?: () => number; mono?: () => number; log?: (l: string) => void } = {}) {
  return new Metrics({
    dir,
    version: '6.0.0-test',
    mode: 'lazy',
    transport: 'stdio',
    now: opts.now,
    monotonic: opts.mono,
    log: opts.log ?? (() => {}),
  });
}

const okResult = (text = 'x') => ({ content: [{ type: 'text', text }] });
const errResult = (envelope: Record<string, unknown>) => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify(envelope) }],
});
const entry = (name: string) => ({ name, service: name.split('_')[0], meta: false, generated: false });

function readDay(dir: string): Record<string, any> {
  const f = fs.readdirSync(path.join(dir, 'agg')).find((x) => x.endsWith('.json'))!;
  return JSON.parse(fs.readFileSync(path.join(dir, 'agg', f), 'utf-8'));
}

describe('resolveUsageMetrics (fail-closed table)', () => {
  it('default off with no env and no config', () => {
    const s = resolveUsageMetrics({}, undefined);
    expect(s).toEqual({ enabled: false, source: { kind: 'default' } });
  });
  it('config true enables with config source', () => {
    const s = resolveUsageMetrics({}, true);
    expect(s.enabled).toBe(true);
    expect(sourceLabel(s.source)).toBe('(config)');
  });
  it('env wins over config, both directions, case-insensitive and trimmed', () => {
    expect(resolveUsageMetrics({ GOOGLE_USAGE_METRICS: ' On ' }, false).enabled).toBe(true);
    expect(resolveUsageMetrics({ GOOGLE_USAGE_METRICS: 'OFF' }, true).enabled).toBe(false);
    for (const v of ['1', 'true', 'YES']) expect(resolveUsageMetrics({ GOOGLE_USAGE_METRICS: v }, undefined).enabled).toBe(true);
    for (const v of ['0', 'false', 'no']) expect(resolveUsageMetrics({ GOOGLE_USAGE_METRICS: v }, true).enabled).toBe(false);
  });
  it('empty env value is unset: config decides, no warning', () => {
    const s = resolveUsageMetrics({ GOOGLE_USAGE_METRICS: '' }, true);
    expect(s.enabled).toBe(true);
    expect(s.warning).toBeUndefined();
  });
  it('garbage env value: exactly one warning and OFF, even with config true', () => {
    const s = resolveUsageMetrics({ GOOGLE_USAGE_METRICS: 'maybe' }, true);
    expect(s.enabled).toBe(false);
    expect(s.warning).toContain('maybe');
  });
  it('env-file source is attributed when provided', () => {
    const s = resolveUsageMetrics({ GOOGLE_USAGE_METRICS: 'on' }, undefined, '/srv/mcp/.env');
    expect(sourceLabel(s.source)).toBe('(env file: /srv/mcp/.env)');
  });
});

describe('off is off (the load-bearing set)', () => {
  it('initUsageMetrics returns null and creates nothing, even with a path set', () => {
    const dir = tmp();
    const m = initUsageMetrics({ enabled: false, source: { kind: 'default' } }, {
      dir, version: 'v', mode: 'lazy', transport: 'stdio',
    });
    expect(m).toBeNull();
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe('buckets', () => {
  it('latency boundaries', () => {
    expect(latBucket(100)).toBe('le100');
    expect(latBucket(101)).toBe('le250');
    expect(latBucket(30000)).toBe('le30000');
    expect(latBucket(30001)).toBe('gt30000');
  });
  it('chars boundaries (powers of 4)', () => {
    expect(charsBucket(64)).toBe('le64');
    expect(charsBucket(65)).toBe('le256');
    expect(charsBucket(65536)).toBe('le65536');
    expect(charsBucket(65537)).toBe('gt65536');
  });
  it('fan-out widths bucket with no exact counts', () => {
    expect(fanBucket(1)).toBeUndefined();
    expect(fanBucket(2)).toBe('w2');
    expect(fanBucket(4)).toBe('w3to4');
    expect(fanBucket(7)).toBe('w5plus');
  });
});

describe('recording and derivations', () => {
  it('counts calls, errors, hints and latencies per tool', async () => {
    const dir = tmp();
    let t = 0;
    const m = make(dir, { mono: () => (t += 50) });
    const wrapped = m.wrap(entry('gmail_search'), async () => errResult({ error: 'invalid_query', message: 'x', hint: 'try', retriable: false, account: 'a' }));
    await wrapped({});
    const ok = m.wrap(entry('gmail_search'), async () => okResult('y'.repeat(500)));
    await ok({});
    m.flush();
    const day = readDay(dir);
    expect(day.calls).toBe(2);
    expect(day.tools.gmail_search.n).toBe(2);
    expect(day.tools.gmail_search.err.invalid_query).toBe(1);
    expect(day.tools.gmail_search.hint).toBe(1);
    expect(day.hints.invalid_query).toEqual({ hinted: 1, unhinted: 0 });
  });

  it('an unknown slug buckets to other, and a hostile email-shaped slug never reaches the file', async () => {
    const dir = tmp();
    const m = make(dir);
    const w = m.wrap(entry('drive_search'), async () => errResult({ error: 'baki@example.com', message: 'x', retriable: false, account: 'a' }));
    await w({});
    m.flush();
    const raw = fs.readFileSync(path.join(dir, 'agg', fs.readdirSync(path.join(dir, 'agg'))[0]), 'utf-8');
    expect(raw).not.toContain('@');
    expect(readDay(dir).tools.drive_search.err.other).toBe(1);
  });

  it('retry self-correction: hinted error then success inside the window', async () => {
    const dir = tmp();
    let t = 0;
    const m = make(dir, { mono: () => t });
    const failing = m.wrap(entry('tasks_update'), async () => errResult({ error: 'validation_error', message: 'x', hint: 'fix it', retriable: false, account: 'a' }));
    const succeeding = m.wrap(entry('tasks_update'), async () => okResult());
    await failing({});
    t += 60_000; // inside the 10-minute window
    await succeeding({});
    m.flush();
    expect(readDay(dir).retries.validation_error).toEqual({ hintedOk: 1, hintedFail: 0, unhintedOk: 0, unhintedFail: 0 });
  });

  it('retry outside the window records nothing', async () => {
    const dir = tmp();
    let t = 0;
    const m = make(dir, { mono: () => t });
    await m.wrap(entry('tasks_update'), async () => errResult({ error: 'not_found', message: 'x', retriable: false, account: 'a' }))({});
    t += 11 * 60_000;
    await m.wrap(entry('tasks_update'), async () => okResult())({});
    m.flush();
    expect(readDay(dir).retries).toEqual({});
  });

  it('bigrams chain in order and break on a 5-minute gap', async () => {
    const dir = tmp();
    let t = 0;
    const m = make(dir, { mono: () => t });
    await m.wrap(entry('gmail_search'), async () => okResult())({});
    t += 1000;
    await m.wrap(entry('gmail_read'), async () => okResult())({});
    t += 6 * 60_000;
    await m.wrap(entry('drive_search'), async () => okResult())({});
    m.flush();
    const day = readDay(dir);
    expect(day.bigrams['gmail_search>gmail_read']).toBe(1);
    expect(day.bigrams['gmail_read>drive_search']).toBeUndefined();
  });

  it('fan-out width arrives bucketed, never exact, never aliases', async () => {
    const dir = tmp();
    const m = make(dir);
    const w = m.wrap(entry('gmail_search'), async () => okResult(), () => 7);
    await w({ account: 'a,b,c,d,e,f,g' });
    m.flush();
    const day = readDay(dir);
    expect(day.tools.gmail_search.fanout).toEqual({ calls: 1, w5plus: 1 });
    const raw = JSON.stringify(day);
    expect(raw).not.toContain('a,b');
    expect(raw).not.toContain('"7"');
  });

  it('escape methodId is shape-gated; a miss counts unknown_method', () => {
    const dir = tmp();
    const m = make(dir);
    m.recordEscapeMethod('sheets.spreadsheets.values.update');
    m.recordEscapeMethod('NOT A METHOD ID!!');
    m.recordEscapeMethod('x'.repeat(200));
    m.recordEscapeMethod(null);
    m.recordSearchApi(['analyticsadmin', 'analyticsdata']);
    m.recordSearchApi(null);
    m.flush();
    const day = readDay(dir);
    expect(day.escape.methods).toEqual({ 'sheets.spreadsheets.values.update': 1 });
    expect(day.escape.unknown_method).toBe(1);
    expect(day.escape.apis_searched).toEqual({ analyticsadmin: 1, analyticsdata: 1 });
    expect(day.escape.unknown_api).toBe(1);
    expect(JSON.stringify(day)).not.toContain('NOT A METHOD');
  });

  it('rpc enumeration is closed: unknown codes bucket to rpc_error_other', () => {
    const dir = tmp();
    const m = make(dir);
    m.recordRpc('tool_not_found');
    m.recordRpc(-32601);
    m.recordRpc(-31999);
    m.recordRpc('schema_validation', 'tasks_update');
    m.flush();
    const day = readDay(dir);
    expect(day.rpc).toEqual({ tool_not_found: 1, 'rpc_error_-32601': 1, rpc_error_other: 1 });
    expect(day.validation).toEqual({ tasks_update: 1 });
  });

  it('a hostile result shape never fails the wrapped call', async () => {
    const dir = tmp();
    const m = make(dir);
    const evil = { isError: true, content: [{ type: 'text', get text(): string { throw new Error('boom'); } }] };
    const w = m.wrap(entry('gmail_search'), async () => evil as never);
    await expect(w({})).resolves.toBe(evil);
  });
});

describe('format guard: every persisted string is vocabulary, shape, or other/unknown/_overflow', () => {
  it('walks a produced day document', async () => {
    const dir = tmp();
    const m = make(dir);
    await m.wrap(entry('gmail_search'), async () => errResult({ error: 'not_found', message: 'x', hint: 'h', retriable: false, account: 'a' }))({});
    await m.wrap(entry('gmail_read'), async () => okResult())({});
    m.recordEscapeMethod('gmail.users.messages.list');
    m.recordRpc(-32700);
    m.flush();
    const day = readDay(dir);
    const TOOL_RE = /^[a-z][a-z0-9_]*$/;
    const METHOD_RE = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/;
    const BUCKET_RE = /^(le\d+|gt\d+|w2|w3to4|w5plus)$/;
    const BOOT_RE = /^[^/]+\/(lazy|curated|eager)\/(stdio|http)$/;
    const RPC_RE = /^(tool_not_found|rpc_error_(-32700|-32600|-32601|-32603)|rpc_error_other)$/;
    const okKey = (k: string) =>
      TOOL_RE.test(k) || METHOD_RE.test(k) || BUCKET_RE.test(k) || BOOT_RE.test(k) || RPC_RE.test(k) ||
      KNOWN_ERROR_SLUGS.has(k) || /^([a-z0-9_]+)>([a-z0-9_]+)$/.test(k) ||
      ['v', 'day', 'boots', 'node', 'calls', 'tools', 'hints', 'retries', 'escape', 'validation', 'rpc', 'bigrams',
        'n', 'err', 'hint', 'lat', 'fanout', 'argfix', 'calls', 'methods', '_overflow', 'unknown_method',
        'apis_searched', 'unknown_api', 'hinted', 'unhinted', 'hintedOk', 'hintedFail', 'unhintedOk', 'unhintedFail',
        'other'].includes(k);
    const walk = (v: unknown, keyPath: string[]): void => {
      if (typeof v === 'string') {
        const isDay = /^\d{4}-\d{2}-\d{2}$/.test(v);
        const isNode = /^v\d+\.\d+\.\d+$/.test(v);
        expect(isDay || isNode, `string value "${v}" at ${keyPath.join('.')}`).toBe(true);
        return;
      }
      if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          expect(okKey(k), `key "${k}" at ${keyPath.join('.')}`).toBe(true);
          walk(x, [...keyPath, k]);
        }
      }
    };
    walk(day, []);
  });
});

describe('storage discipline', () => {
  it('two concurrent recorders merge into one day file (sum, not clobber)', async () => {
    const dir = tmp();
    const a = make(dir);
    const b = make(dir);
    await a.wrap(entry('gmail_search'), async () => okResult())({});
    await b.wrap(entry('gmail_search'), async () => okResult())({});
    a.flush();
    b.flush();
    const day = readDay(dir);
    expect(day.tools.gmail_search.n).toBe(2);
    expect(day.boots['6.0.0-test/lazy/stdio']).toBe(2);
  });

  it('a corrupt day file starts fresh without throwing', async () => {
    const dir = tmp();
    const m = make(dir);
    fs.mkdirSync(path.join(dir, 'agg'), { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(dir, 'agg', `${day}.json`), '{not json');
    await m.wrap(entry('gmail_search'), async () => okResult())({});
    m.flush();
    expect(readDay(dir).tools.gmail_search.n).toBe(1);
  });

  it('boot prunes aggregate files older than 180 days and keeps young ones', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'agg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'agg', '2020-01-01.json'), '{}');
    fs.writeFileSync(path.join(dir, 'agg', 'not-a-day.json'), '{}');
    const young = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(dir, 'agg', `${young}.json`), '{}');
    make(dir);
    const left = fs.readdirSync(path.join(dir, 'agg')).sort();
    expect(left).toEqual([`${young}.json`, 'not-a-day.json']);
  });

  it('event age prune drops only stale lines and torn lines', () => {
    const dir = tmp();
    fs.mkdirSync(dir, { recursive: true });
    const young = JSON.stringify({ ts: new Date().toISOString().slice(0, 16) + ':00Z', tool: 'gmail_read' });
    const stale = JSON.stringify({ ts: '2020-01-01T00:00:00Z', tool: 'gmail_read' });
    fs.writeFileSync(path.join(dir, 'events.jsonl'), `${stale}\n${young}\n{torn`);
    make(dir);
    const left = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf-8').trim().split('\n');
    expect(left).toEqual([young]);
  });

  it('3 consecutive write failures self-disable the writer; calls keep succeeding', async () => {
    const dir = tmp();
    const logs: string[] = [];
    const m = make(dir, { log: (l) => logs.push(l) });
    // Replace the metrics dir with a plain FILE: every flush path (lock mkdir,
    // atomic write, event append) then fails on every platform.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, 'not a directory');
    const w = m.wrap(entry('gmail_search'), async () => okResult());
    for (let i = 0; i < 4; i++) {
      await w({});
      m.flush();
    }
    await expect(w({})).resolves.toEqual(okResult());
    expect(logs.some((l) => l.includes('disabled for this process'))).toBe(true);
  });

  // POSIX-only by nature: Windows has no 0700-style mode semantics to warn about.
  it.skipIf(process.platform === 'win32')('a pre-existing group-readable dir warns once and is never chmodded', () => {
    const dir = tmp();
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    const logs: string[] = [];
    make(dir, { log: (l) => logs.push(l) });
    expect(logs.filter((l) => l.includes('wider than 0700')).length).toBe(1);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
  });

  it('events append with minute-precision timestamps only', async () => {
    const dir = tmp();
    const m = make(dir, { now: () => Date.parse('2026-09-20T10:11:42.123Z') });
    await m.wrap(entry('gmail_search'), async () => okResult())({});
    m.flush();
    const line = JSON.parse(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf-8').trim());
    expect(line.ts).toBe('2026-09-20T10:11:00Z');
    expect(line.tool).toBe('gmail_search');
    expect(line.chars).toBe('le64');
  });
});

describe('egress guard (structural)', () => {
  const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf-8');

  it('metrics module imports are an allowlist subset with no dynamic import', () => {
    const base = ['node:fs', 'node:path', 'node:os', 'node:crypto', 'node:perf_hooks', './fs-atomic.js'];
    const perFile: Record<string, Set<string>> = {
      // the CLI reads the same local files through the guarded module; its
      // promotion join data is passed IN by the dispatcher, never imported.
      'src/usage-metrics.ts': new Set(base),
      'src/metrics-cli.ts': new Set([...base, './usage-metrics.js']),
    };
    for (const [file, allowed] of Object.entries(perFile)) {
      const src = read(file);
      for (const m of src.matchAll(/from '([^']+)'/g)) {
        expect(allowed.has(m[1]), `${file}: disallowed import ${m[1]}`).toBe(true);
      }
      expect(src.includes('import('), `${file}: dynamic import`).toBe(false);
    }
  });

  it('the metrics dir constant is referenced only by the metrics modules', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.name.endsWith('.ts') && fs.readFileSync(p, 'utf-8').includes('METRICS_DIR_NAME')) offenders.push(f.name);
      }
    };
    walk(path.join(__dirname, '..', 'src'));
    expect(offenders.every((f) => ['usage-metrics.ts', 'metrics-cli.ts'].includes(f)), offenders.join(',')).toBe(true);
  });
});

describe('KNOWN_ERROR_SLUGS honesty', () => {
  it('equals the set of error slug literals emitted across src/', () => {
    const found = new Set<string>();
    const walk = (dir: string): void => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.name.endsWith('.ts')) {
          const src = fs.readFileSync(p, 'utf-8');
          for (const m of src.matchAll(/error: '([A-Za-z0-9_]+)'/g)) found.add(m[1]);
          for (const m of src.matchAll(/error: "([A-Za-z0-9_]+)"/g)) found.add(m[1]);
          // Envelopes built through a helper carry the slug as an argument, so
          // an `error:` scan alone misses every wizard failure.
          for (const m of src.matchAll(/errorResult\(\s*'([A-Za-z0-9_]+)'/g)) found.add(m[1]);
          // `slug:` is the same namespace everywhere EXCEPT doctor.ts, where it
          // identifies a report LINE and never reaches an error envelope.
          if (f.name !== 'doctor.ts') {
            for (const m of src.matchAll(/slug: '([A-Za-z0-9_]+)'/g)) found.add(m[1]);
          }
        }
      }
    };
    walk(path.join(__dirname, '..', 'src'));
    found.delete('other'); // the bucket literal is not a source slug
    expect([...found].sort()).toEqual([...KNOWN_ERROR_SLUGS].sort());
  });
});
