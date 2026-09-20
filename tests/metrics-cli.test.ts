import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyPromotion, runMetricsCli, type PromotionData } from '../src/metrics-cli.js';
import type { DayAgg } from '../src/usage-metrics.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function stateHome(): { home: string; dir: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-cli-'));
  dirs.push(home);
  const dir = path.join(home, 'mcp-google-multi', 'metrics');
  fs.mkdirSync(path.join(dir, 'agg'), { recursive: true });
  return { home, dir };
}

function day(dayStr: string, tools: Record<string, number>, extra: Partial<DayAgg> = {}): DayAgg {
  return {
    v: 1, day: dayStr, boots: { '6.0.0/lazy/stdio': 1 }, node: 'v22.0.0',
    calls: Object.values(tools).reduce((s, v) => s + v, 0),
    tools: Object.fromEntries(Object.entries(tools).map(([k, n]) => [k, { n, err: {}, hint: 0, lat: {} }])),
    hints: {}, retries: {},
    escape: { methods: {}, _overflow: 0, unknown_method: 0, apis_searched: {}, unknown_api: 0 },
    validation: {}, rpc: {}, bigrams: {},
    ...extra,
  };
}

const PROMO: PromotionData = {
  methodMap: {
    'analyticsadmin.properties.keyEvents.create': 'analytics_properties_keyevents_create',
    'webmasters.sitemaps.list': 'searchconsole_sitemaps_list',
  },
  curatedIds: ['webmasters.sitemaps.list', 'gmail.users.messages.list'],
};

function run(argv: string[], opts: { env?: NodeJS.ProcessEnv; enabled?: boolean } = {}) {
  const lines: string[] = [];
  const code = runMetricsCli(['node', 'index.js', 'metrics', ...argv], {
    enabled: opts.enabled ?? true,
    promotion: PROMO,
    env: opts.env ?? {},
    out: (l) => lines.push(l),
  });
  return { code, text: lines.join('\n') };
}

describe('metrics report', () => {
  it('prints the off message and exits 0 on an off instance', () => {
    const { home } = stateHome();
    const r = run(['report'], { env: { XDG_STATE_HOME: home }, enabled: false });
    expect(r.code).toBe(0);
    expect(r.text).toContain('off (default)');
  });

  it('sums day files and reports per tool', () => {
    const { home, dir } = stateHome();
    fs.writeFileSync(path.join(dir, 'agg', '2026-09-18.json'), JSON.stringify(day('2026-09-18', { gmail_search: 3 })));
    fs.writeFileSync(path.join(dir, 'agg', '2026-09-19.json'), JSON.stringify(day('2026-09-19', { gmail_search: 2, drive_search: 1 })));
    const r = run(['report'], { env: { XDG_STATE_HOME: home } });
    expect(r.code).toBe(0);
    expect(r.text).toContain('2 day file(s), 6 calls');
    expect(r.text).toMatch(/gmail_search\s+5/);
  });

  it('--json round-trips through merge', () => {
    const { home, dir } = stateHome();
    fs.writeFileSync(path.join(dir, 'agg', '2026-09-19.json'), JSON.stringify(day('2026-09-19', { gmail_search: 4 })));
    const j1 = run(['report', '--json'], { env: { XDG_STATE_HOME: home } });
    const outFile = path.join(home, 'a.json');
    fs.writeFileSync(outFile, j1.text);
    const rawDay = path.join(home, 'raw.json');
    fs.writeFileSync(rawDay, JSON.stringify(day('2026-09-20', { gmail_search: 6 })));
    const merged = run(['merge', outFile, rawDay, '--json']);
    expect(merged.code).toBe(0);
    expect(JSON.parse(merged.text).agg.tools.gmail_search.n).toBe(10);
  });

  it('merge rejects a file that is neither shape', () => {
    const { home } = stateHome();
    const bad = path.join(home, 'bad.json');
    fs.writeFileSync(bad, '{"nope": true}');
    expect(run(['merge', bad]).code).toBe(2);
  });
});

describe('classifyPromotion', () => {
  it('classifies generated traffic, escape twins and gaps; curated drops out', () => {
    const merged = day('2026-09-19', { analytics_properties_keyevents_create: 7 }, {
      escape: {
        methods: {
          'gmail.users.messages.list': 9, // curated: must drop out
          'analyticsadmin.properties.keyEvents.create': 3, // generated twin: visibility failure
          'chat.spaces.members.list': 2, // no tool: generation gap
        },
        _overflow: 0, unknown_method: 0, apis_searched: {}, unknown_api: 0,
      },
    });
    const rows = classifyPromotion(merged, PROMO);
    expect(rows).toEqual([
      { methodId: 'analyticsadmin.properties.keyEvents.create', tool: 'analytics_properties_keyevents_create', calls: 7, kind: 'curation-candidate' },
      { methodId: 'analyticsadmin.properties.keyEvents.create', tool: 'analytics_properties_keyevents_create', calls: 3, kind: 'visibility-failure' },
      { methodId: 'chat.spaces.members.list', calls: 2, kind: 'generation-gap' },
    ]);
  });

  it('joins a legacy-prefix id against the curated list through tail normalization', () => {
    const merged = day('2026-09-19', {}, {
      escape: {
        // recorded under the doc's own prefix; curated list carries webmasters.*
        methods: { 'searchconsole.sitemaps.list': 4 },
        _overflow: 0, unknown_method: 0, apis_searched: {}, unknown_api: 0,
      },
    });
    expect(classifyPromotion(merged, PROMO)).toEqual([]);
  });

  it('a generated tool whose method is curated never becomes a candidate', () => {
    const merged = day('2026-09-19', { searchconsole_sitemaps_list: 5 });
    expect(classifyPromotion(merged, PROMO)).toEqual([]);
  });
});
