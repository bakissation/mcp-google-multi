import * as fs from 'node:fs';
import * as path from 'node:path';
import { describeMetricsDir, mergeDay, type DayAgg } from './usage-metrics.js';

// `metrics` CLI (spec section 5): reads LOCAL files only, works whether the
// server runs or not, and data moves only when the operator moves it. Same
// no-egress discipline as usage-metrics.ts: the import set is fs/path plus the
// metrics module, enforced by the same allowlist test. The promotion join data
// (generated method map + curated snapshot) is passed IN by the dispatcher so
// this module never reaches into generated code or build scripts.

export interface PromotionData {
  methodMap: Record<string, string>;
  curatedIds: readonly string[];
}

export interface MetricsCliDeps {
  enabled: boolean;
  promotion: PromotionData;
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
}

function loadDayDocs(dir: string, sinceDays?: number): DayAgg[] {
  const aggDir = path.join(dir, 'agg');
  let files: string[];
  try {
    files = fs.readdirSync(aggDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  } catch {
    return [];
  }
  const cutoff = sinceDays !== undefined ? Date.now() - sinceDays * 86_400_000 : undefined;
  const docs: DayAgg[] = [];
  for (const f of files) {
    if (cutoff !== undefined && Date.parse(`${f.slice(0, 10)}T00:00:00Z`) < cutoff) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(aggDir, f), 'utf-8')) as DayAgg;
      if (doc && doc.v === 1) docs.push(doc);
    } catch { /* unreadable day file: skip, the report is best-effort */ }
  }
  return docs;
}

function sum(docs: DayAgg[]): DayAgg {
  return docs.reduce((a, b) => mergeDay(a, b));
}

function parseSince(argv: string[]): number | undefined {
  const i = argv.indexOf('--since');
  if (i === -1 || !argv[i + 1]) return undefined;
  const m = argv[i + 1].match(/^(\d+)d$/);
  return m ? Number(m[1]) : undefined;
}

const pct = (num: number, den: number) => (den === 0 ? '-' : `${Math.round((num / den) * 100)}%`);
const top = (m: Record<string, number>, n: number) =>
  Object.entries(m).filter(([k]) => k !== '_overflow').sort((a, b) => b[1] - a[1]).slice(0, n);

function renderReport(merged: DayAgg, days: number, out: (l: string) => void): void {
  out(`local usage metrics: ${days} day file(s), ${merged.calls} calls, node ${merged.node}`);
  out(`boots: ${Object.entries(merged.boots).map(([k, v]) => `${k}=${v}`).join('  ') || '(none)'}`);
  out('');
  out('tool                              calls   err  err%  hint  top slug');
  for (const [name, t] of Object.entries(merged.tools).sort((a, b) => b[1].n - a[1].n).slice(0, 30)) {
    const errs = Object.values(t.err).reduce((s, v) => s + v, 0);
    const slug = top(t.err, 1)[0]?.[0] ?? '';
    out(`${name.padEnd(34)}${String(t.n).padStart(5)}${String(errs).padStart(6)}${pct(errs, t.n).padStart(6)}${String(t.hint).padStart(6)}  ${slug}`);
  }
  const hintRows = Object.entries(merged.hints);
  if (hintRows.length > 0) {
    out('');
    out('hint coverage per error class (hinted/total)');
    for (const [slug, h] of hintRows.sort((a, b) => b[1].hinted + b[1].unhinted - a[1].hinted - a[1].unhinted)) {
      out(`  ${slug.padEnd(24)}${h.hinted}/${h.hinted + h.unhinted} (${pct(h.hinted, h.hinted + h.unhinted)})`);
    }
  }
  const retryRows = Object.entries(merged.retries);
  if (retryRows.length > 0) {
    out('');
    out('retry self-correction per error class (ok/total after hinted vs unhinted errors)');
    for (const [slug, r] of retryRows) {
      out(`  ${slug.padEnd(24)}hinted ${r.hintedOk}/${r.hintedOk + r.hintedFail} (${pct(r.hintedOk, r.hintedOk + r.hintedFail)})  unhinted ${r.unhintedOk}/${r.unhintedOk + r.unhintedFail} (${pct(r.unhintedOk, r.unhintedOk + r.unhintedFail)})`);
    }
  }
  const esc = merged.escape;
  if (Object.keys(esc.methods).length > 0 || esc.unknown_method > 0 || esc.unknown_api > 0) {
    out('');
    out(`escape hatch: unknown_method=${esc.unknown_method} unknown_api=${esc.unknown_api} overflow=${esc._overflow}`);
    for (const [id, n] of top(esc.methods, 20)) out(`  ${id.padEnd(50)}${n}`);
    const apis = top(esc.apis_searched, 10).map(([k, v]) => `${k}=${v}`).join('  ');
    if (apis) out(`  searched: ${apis}`);
  }
  if (Object.keys(merged.validation).length > 0) {
    out('');
    out('schema validation rejections (never reached a handler)');
    for (const [tool, n] of top(merged.validation, 15)) out(`  ${tool.padEnd(34)}${n}`);
  }
  const bigrams = top(merged.bigrams, 10);
  if (bigrams.length > 0) {
    out('');
    out('top tool bigrams');
    for (const [pair, n] of bigrams) out(`  ${pair.padEnd(50)}${n}`);
  }
}

const tail = (id: string) => id.split('.').slice(1).join('.');

interface PromotionRow { methodId: string; tool?: string; calls: number; kind: 'curation-candidate' | 'visibility-failure' | 'generation-gap' }

/** The promotion-queue view: ranked evidence, a human decides (spec section 5). */
export function classifyPromotion(merged: DayAgg, data: PromotionData): PromotionRow[] {
  const curated = new Set<string>();
  for (const id of data.curatedIds) {
    curated.add(id);
    curated.add(tail(id));
  }
  const byId = new Map<string, string>();
  const byTail = new Map<string, string>();
  const toolToId = new Map<string, string>();
  for (const [id, tool] of Object.entries(data.methodMap)) {
    byId.set(id, tool);
    byTail.set(tail(id), tool);
    toolToId.set(tool, id);
  }
  const rows: PromotionRow[] = [];
  // (a) generated tools with real traffic = curation candidates.
  for (const [tool, t] of Object.entries(merged.tools)) {
    const id = toolToId.get(tool);
    if (id && !curated.has(id) && !curated.has(tail(id))) {
      rows.push({ methodId: id, tool, calls: t.n, kind: 'curation-candidate' });
    }
  }
  // (b)/(c) escape methodIds; the tail join covers legacy doc prefixes.
  for (const [id, calls] of Object.entries(merged.escape.methods)) {
    if (curated.has(id) || curated.has(tail(id))) continue; // already curated: drops out
    const twin = byId.get(id) ?? byTail.get(tail(id));
    rows.push(twin
      ? { methodId: id, tool: twin, calls, kind: 'visibility-failure' }
      : { methodId: id, calls, kind: 'generation-gap' });
  }
  return rows.sort((a, b) => b.calls - a.calls);
}

function renderPromotion(rows: PromotionRow[], out: (l: string) => void): void {
  const section = (kind: PromotionRow['kind'], title: string, note: string) => {
    const list = rows.filter((r) => r.kind === kind);
    if (list.length === 0) return;
    out(`### ${title}`);
    out(note);
    out('');
    out('| methodId | tool | calls |');
    out('|---|---|---|');
    for (const r of list) out(`| ${r.methodId} | ${r.tool ?? '(none)'} | ${r.calls} |`);
    out('');
  };
  if (rows.length === 0) {
    out('No promotion evidence yet: no generated-tool traffic and no escape-hatch methodIds recorded.');
    return;
  }
  section('curation-candidate', 'Curation candidates', 'Generated tools with real traffic; a curated wrapper may be earned.');
  section('visibility-failure', 'Visibility failures', 'The escape hatch was used where a generated tool exists; discovery/naming problem, not a coverage gap.');
  section('generation-gap', 'Generation gaps', 'Escape methodIds with no tool at all.');
}

export function runMetricsCli(argv: string[], deps: MetricsCliDeps): number {
  const out = deps.out ?? ((l: string) => process.stdout.write(`${l}\n`));
  const env = deps.env ?? process.env;
  const json = argv.includes('--json');
  const sub = argv.includes('merge') ? 'merge' : 'report';

  let merged: DayAgg | undefined;
  let dayCount = 0;
  if (sub === 'merge') {
    const files = argv.slice(argv.indexOf('merge') + 1).filter((a) => !a.startsWith('--'));
    if (files.length === 0) {
      out('usage: mcp-google-multi metrics merge <file...> [--json]');
      return 2;
    }
    const docs: DayAgg[] = [];
    for (const f of files) {
      let parsed: { v?: number; tools?: unknown; agg?: DayAgg };
      try {
        parsed = JSON.parse(fs.readFileSync(f, 'utf-8'));
      } catch (e) {
        out(`cannot read ${f}: ${(e as Error).message}`);
        return 2;
      }
      // A report wrapper carries {v, days, agg}; a raw day doc carries tools.
      const doc = parsed.agg?.v === 1 ? parsed.agg : parsed.v === 1 && parsed.tools ? (parsed as DayAgg) : undefined;
      if (!doc || doc.v !== 1) {
        out(`${f} is neither a day aggregate nor a metrics report --json output`);
        return 2;
      }
      docs.push(doc);
      dayCount += 1;
    }
    merged = sum(docs);
  } else {
    const dir = describeMetricsDir(env).dir;
    const docs = loadDayDocs(dir, parseSince(argv));
    if (docs.length === 0) {
      out(deps.enabled
        ? `local usage metrics are on but no day files exist yet under ${dir}`
        : 'local usage metrics are off (default); enable with GOOGLE_USAGE_METRICS=on');
      return 0;
    }
    merged = sum(docs);
    dayCount = docs.length;
  }

  if (argv.includes('--promotion')) {
    const rows = classifyPromotion(merged, deps.promotion);
    if (json) out(JSON.stringify({ v: 1, days: dayCount, promotion: rows }));
    else renderPromotion(rows, out);
    return 0;
  }
  if (json) {
    out(JSON.stringify({ v: 1, days: dayCount, agg: merged }));
    return 0;
  }
  renderReport(merged, dayCount, out);
  return 0;
}
