import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { ToolRegistry } from './registry.js';
import { getAccountSet } from './accounts.js';
import { deriveAccountHealth, type AccountHealth } from './tools/accounts-tool.js';
import { peekMasterKeyProvenance, deleteMasterKeyMaterial } from './master-key.js';
import { hasToken } from './token-store.js';
import { configDir } from './config-file.js';

// B9: one engine (runDiagnostics), two skins — `doctor` (CLI glyph) and
// `diagnose` (agent tool, structured). Sections 1-6 here; section 7 (HTTP:
// PRM/AS-metadata self-fetch, MCP_PUBLIC_URL canonicalization) is owned by the
// OAuth AS and lands with that cluster (B11-B14), so it is reported as a
// deferred note, never a FAIL. Read-only (BR7): no mutation, only probes.

export type Verdict = 'ok' | 'warn' | 'fail' | 'unknown';

export interface DiagnosticSection {
  id: number;
  title: string;
  verdict: Verdict;
  lines: string[];
  /** copy-pasteable remediation (gh-CLI style), attached only on warn/fail. */
  hint?: string;
  slug?: string;
}

export interface DiagnosticsReport {
  verdict: Verdict;
  sections: DiagnosticSection[];
}

/** One API-enablement probe outcome for a single service (section 6). */
export interface ApiProbeResult {
  service: string;
  /** discovery API id used for the per-API console deep-link, e.g. "gmail". */
  api: string;
  ok: boolean;
  /** true only for accessNotConfigured / SERVICE_DISABLED (the actionable case). */
  notEnabled?: boolean;
  message?: string;
}

export interface DiagnosticsDeps {
  nodeVersion: string;
  env: Record<string, string | undefined>;
  cwd: string;
  accountSet: () => ReturnType<typeof getAccountSet> | null;
  accountHealth: (alias: string) => AccountHealth;
  masterKeyProvenance: () => ReturnType<typeof peekMasterKeyProvenance>;
  anyTokensExist: (aliases: string[]) => boolean;
  fileExists: (p: string) => boolean;
  /** Optional live section-6 probe; when absent the section reports `unknown`
   * (spec: a section that cannot run is unknown, not FAIL). */
  probeApi?: (alias: string) => Promise<ApiProbeResult[]>;
}

const MIN_NODE_MAJOR = 22;

const DEFAULT_DEPS: DiagnosticsDeps = {
  nodeVersion: process.versions.node,
  env: process.env,
  cwd: process.cwd(),
  accountSet: () => {
    try {
      return getAccountSet();
    } catch {
      return null;
    }
  },
  accountHealth: (alias) => deriveAccountHealth(alias),
  masterKeyProvenance: () => peekMasterKeyProvenance(),
  anyTokensExist: (aliases) => aliases.some((a) => hasToken(a)),
  fileExists: fs.existsSync,
};

/** Console deep-link to enable one API (section-6 hint, error taxonomy B10). */
export function apiEnableLink(api: string): string {
  return `https://console.cloud.google.com/apis/library/${api}.googleapis.com`;
}

function transportsFrom(env: Record<string, string | undefined>): string[] {
  return (env.MCP_TRANSPORT ?? 'stdio')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const LEGACY_ENV_KEYS = ['GOOGLE_ACCOUNTS', 'GOOGLE_OPTIONAL_SCOPES', 'GOOGLE_ADMIN_ACCOUNTS'] as const;

function sectionRuntime(deps: DiagnosticsDeps): DiagnosticSection {
  const major = Number.parseInt(deps.nodeVersion.split('.')[0] ?? '0', 10);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    return {
      id: 1,
      title: 'Runtime',
      verdict: 'fail',
      slug: 'E_NODE_TOO_OLD',
      lines: [`Node.js ${deps.nodeVersion} (requires >= ${MIN_NODE_MAJOR})`],
      hint: `Upgrade to Node ${MIN_NODE_MAJOR} LTS or newer.`,
    };
  }
  return { id: 1, title: 'Runtime', verdict: 'ok', lines: [`Node.js ${deps.nodeVersion} (>= ${MIN_NODE_MAJOR})`] };
}

function sectionConfig(deps: DiagnosticsDeps, set: ReturnType<typeof getAccountSet> | null): DiagnosticSection {
  const lines: string[] = [];
  let verdict: Verdict = 'ok';
  let hint: string | undefined;
  let slug: string | undefined;

  if (!set || set.aliases.length === 0) {
    return {
      id: 2,
      title: 'Config',
      verdict: 'fail',
      slug: 'E_NO_ACCOUNTS_CONFIGURED',
      lines: ['No accounts configured.'],
      hint: 'Add an account: run `npx mcp-google-multi migrate-config` or set GOOGLE_ACCOUNTS.',
    };
  }

  const cfgPath = path.join(configDir(), 'config.json');
  lines.push(deps.fileExists(cfgPath) ? `config.json present (${set.aliases.length} account(s))` : `config.json absent — accounts sourced from env (${set.aliases.length})`);

  const legacyEnv = LEGACY_ENV_KEYS.filter((k) => deps.env[k]);
  if (legacyEnv.length > 0) {
    verdict = 'warn';
    slug = 'E_LEGACY_ENV';
    lines.push(`Legacy env in effect: ${legacyEnv.join(', ')}`);
    hint = 'Fold legacy env into config.json: `npx mcp-google-multi migrate-config`.';
  }

  // Legacy .env in CWD / package root shadows the ~/.config location.
  for (const dir of [deps.cwd]) {
    const envFile = path.join(dir, '.env');
    if (deps.fileExists(envFile)) {
      if (verdict === 'ok') verdict = 'warn';
      lines.push(`Legacy .env found at ${envFile}`);
      const target = path.join(configDir(), '.env');
      hint = (hint ? `${hint} ` : '') + `Move it: \`mv ${envFile} ${target}\`.`;
    }
  }

  return { id: 2, title: 'Config', verdict, lines, ...(hint ? { hint } : {}), ...(slug ? { slug } : {}) };
}

function sectionKeys(deps: DiagnosticsDeps, aliases: string[]): DiagnosticSection {
  const provenance = deps.masterKeyProvenance();
  const tokensExist = deps.anyTokensExist(aliases);

  if (provenance === 'unprovisioned' && tokensExist) {
    return {
      id: 3,
      title: 'Keys',
      verdict: 'fail',
      slug: 'E_MASTER_KEY_MISSING_TOKENS_EXIST',
      lines: ['MASTER_KEY is unprovisioned but encrypted tokens exist — they cannot be decrypted.'],
      hint: 'Restore the original MASTER_KEY, or `npx mcp-google-multi reset` and re-auth.',
    };
  }
  const line = provenance === 'unprovisioned'
    ? 'MASTER_KEY: unprovisioned (generated on first use)'
    : `MASTER_KEY provenance: ${provenance}`;
  return { id: 3, title: 'Keys', verdict: 'ok', lines: [line] };
}

function sectionsTokensAndScopes(deps: DiagnosticsDeps, aliases: string[]): [DiagnosticSection, DiagnosticSection] {
  const tokenLines: string[] = [];
  const scopeLines: string[] = [];
  let tokenVerdict: Verdict = 'ok';
  let scopeVerdict: Verdict = 'ok';
  let tokenHint: string | undefined;
  let scopeHint: string | undefined;
  let sawMissing = false;

  for (const alias of aliases) {
    const h = deps.accountHealth(alias);
    const s = h.token.status;
    tokenLines.push(`${alias} (${h.email}): ${s}${h.token.expiryDate ? ` — expires ${h.token.expiryDate}` : ''}`);
    if (s === 'missing' || s === 'needs_reauth' || s === 'decrypt_error') {
      tokenVerdict = 'fail';
      if (s === 'missing') sawMissing = true;
      if (h.token.hint) tokenHint = h.token.hint;
    } else if (s === 'expired_refreshable' && tokenVerdict === 'ok') {
      // refreshes transparently on next use — not a failure.
      tokenLines[tokenLines.length - 1] += ' (auto-refreshes on use)';
    }

    const r = h.scopes;
    if (r.requestable.length > 0) {
      if (scopeVerdict === 'ok') scopeVerdict = 'warn';
      scopeLines.push(`${alias}: ${r.callable.length} callable, ${r.requestable.length} requested-not-granted`);
      scopeHint = `Re-auth to grant missing scopes: \`npx mcp-google-multi auth --account ${alias}\`.`;
    } else {
      scopeLines.push(`${alias}: ${r.callable.length} callable, all profile scopes granted`);
    }
  }

  return [
    { id: 4, title: 'Tokens', verdict: tokenVerdict, lines: tokenLines, ...(tokenHint ? { hint: tokenHint } : {}), ...(tokenVerdict === 'fail' ? { slug: sawMissing ? 'E_AUTH_REQUIRED' : 'E_REAUTH_REQUIRED' } : {}) },
    { id: 5, title: 'Scopes', verdict: scopeVerdict, lines: scopeLines, ...(scopeHint ? { hint: scopeHint } : {}), ...(scopeVerdict === 'warn' ? { slug: 'E_SCOPE_NOT_GRANTED' } : {}) },
  ];
}

async function sectionApiEnablement(deps: DiagnosticsDeps, aliases: string[]): Promise<DiagnosticSection> {
  if (!deps.probeApi) {
    return { id: 6, title: 'API enablement', verdict: 'unknown', lines: ['Probe not run (no live account probe configured).'] };
  }
  // Probe on the first alias with a live token; can't probe without one.
  const healthy = aliases.find((a) => {
    const st = deps.accountHealth(a).token.status;
    return st === 'ok' || st === 'expired_refreshable';
  });
  if (!healthy) {
    return { id: 6, title: 'API enablement', verdict: 'unknown', lines: ['No authenticated account to probe with.'] };
  }
  let results: ApiProbeResult[];
  try {
    results = await deps.probeApi(healthy);
  } catch (e: any) {
    // Network / transient: WARN with the target, never crash the report.
    return { id: 6, title: 'API enablement', verdict: 'warn', lines: [`Probe could not complete: ${e?.message ?? e}`] };
  }
  const disabled = results.filter((r) => r.notEnabled);
  const lines = results.map((r) => `${r.service}: ${r.ok ? 'enabled' : r.notEnabled ? 'NOT ENABLED' : `unknown (${r.message ?? 'error'})`}`);
  if (disabled.length > 0) {
    return {
      id: 6,
      title: 'API enablement',
      verdict: 'fail',
      slug: 'E_API_NOT_ENABLED',
      lines,
      hint: disabled.map((r) => `Enable ${r.service}: ${apiEnableLink(r.api)}`).join('\n'),
    };
  }
  return { id: 6, title: 'API enablement', verdict: 'ok', lines: lines.length ? lines : ['(probed account, all enabled)'] };
}

function sectionHttpDeferred(deps: DiagnosticsDeps): DiagnosticSection | null {
  if (!transportsFrom(deps.env).includes('http')) return null;
  return {
    id: 7,
    title: 'HTTP',
    verdict: 'unknown',
    lines: ['HTTP diagnostics (MCP_PUBLIC_URL canonicalization, MCP_OWNER_EMAILS, PRM/AS-metadata self-fetch) land with the OAuth authorization server (not yet built).'],
  };
}

const RANK: Record<Verdict, number> = { ok: 0, unknown: 0, warn: 1, fail: 2 };

/** Roll section verdicts to an overall verdict. `unknown` never worsens it. */
export function overallVerdict(sections: DiagnosticSection[]): Verdict {
  let worst: Verdict = 'ok';
  for (const s of sections) {
    if (RANK[s.verdict] > RANK[worst]) worst = s.verdict;
  }
  return worst;
}

export async function runDiagnostics(deps: DiagnosticsDeps = DEFAULT_DEPS): Promise<DiagnosticsReport> {
  const sections: DiagnosticSection[] = [];
  sections.push(sectionRuntime(deps));

  const set = deps.accountSet();
  sections.push(sectionConfig(deps, set));
  const aliases = set?.aliases ?? [];

  sections.push(sectionKeys(deps, aliases));

  if (aliases.length > 0) {
    const [tokens, scopes] = sectionsTokensAndScopes(deps, aliases);
    sections.push(tokens, scopes);
    sections.push(await sectionApiEnablement(deps, aliases));
  }

  const http = sectionHttpDeferred(deps);
  if (http) sections.push(http);

  return { verdict: overallVerdict(sections), sections };
}

// --- skins -----------------------------------------------------------------

const GLYPH: Record<Verdict, string> = { ok: '✔', warn: '!', fail: '✖', unknown: '·' };

/** doctor CLI (brew-doctor style): glyph-coded human report. */
export function renderDoctorText(report: DiagnosticsReport): string {
  const out: string[] = [];
  for (const s of report.sections) {
    out.push(`${GLYPH[s.verdict]} ${s.id}. ${s.title} [${s.verdict.toUpperCase()}]`);
    for (const l of s.lines) out.push(`    ${l}`);
    if (s.hint) for (const hl of s.hint.split('\n')) out.push(`    → ${hl}`);
  }
  out.push('');
  out.push(`Overall: ${report.verdict.toUpperCase()}`);
  return out.join('\n');
}

/** Mask the local-part of an email so a report never carries a full address (BR8). */
function maskEmails(text: string): string {
  return text.replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+)/g, '$1***$2');
}

/** Redacted, paste-ready bug report (BR8): verdicts + provenance labels + token
 * statuses + slugs; NO token values, secrets, keys, or full email addresses. */
export function renderReport(report: DiagnosticsReport, version: string): string {
  const out: string[] = [`mcp-google-multi doctor report (v${version})`, `overall: ${report.verdict}`, ''];
  for (const s of report.sections) {
    out.push(`[${s.id}] ${s.title}: ${s.verdict}${s.slug ? ` (${s.slug})` : ''}`);
    for (const l of s.lines) out.push(`  ${maskEmails(l)}`);
  }
  return out.join('\n');
}

/** Exit non-zero when any section FAILs; with strict, WARN counts too. */
export function exitCodeFor(report: DiagnosticsReport, strict: boolean): number {
  if (report.verdict === 'fail') return 1;
  if (strict && report.verdict === 'warn') return 1;
  return 0;
}

/** Agent-callable structured health report (read-only). Mirrors `doctor`'s
 * engine; NOT alwaysLoad (the agent asks for it when diagnosing). */
export function registerDiagnoseTool(registry: ToolRegistry): void {
  registry.registerTool(
    'diagnose',
    {
      annotations: { readOnlyHint: true, openWorldHint: true },
      description: 'Health report for this server: runtime, config, keys, per-account token status, scope grants, and API enablement. Read-only; returns copy-pasteable fixes for anything wrong. Call this to diagnose auth/config failures.',
      inputSchema: {},
    },
    async () => {
      try {
        const result = await runDiagnostics();
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'diagnose_failed', message: e?.message ?? String(e) }) }], isError: true };
      }
    },
  );
}

// --- B6 reset ---------------------------------------------------------------

export interface ResetOptions {
  account?: string;
  regenerateKey: boolean;
  yes: boolean;
}
export interface ResetPlan {
  wipeAliases: string[];
  regenerateKey: boolean;
}
export type ResetPlanResult =
  | { ok: true; plan: ResetPlan; reauth: string[] }
  | { ok: false; slug: string; message: string };

/** Pure planner (unit-testable): decide which token files to wipe and whether
 * key regeneration is safe. Refuses --regenerate-key while any account outside
 * the wipe set still holds an encrypted token (a fresh key would brick it). */
export function planReset(opts: ResetOptions, state: { aliases: string[]; tokenPresent: (a: string) => boolean }): ResetPlanResult {
  if (opts.account && !state.aliases.includes(opts.account)) {
    return { ok: false, slug: 'E_VALIDATION', message: `Unknown account "${opts.account}". Known: ${state.aliases.join(', ') || '(none)'}.` };
  }
  const wipeAliases = opts.account ? [opts.account] : [...state.aliases];
  if (opts.regenerateKey) {
    const remaining = state.aliases.filter((a) => !wipeAliases.includes(a) && state.tokenPresent(a));
    if (remaining.length > 0) {
      return {
        ok: false,
        slug: 'E_KEY_REGEN_BLOCKED',
        message: `Refusing --regenerate-key: ${remaining.length} account(s) still hold encrypted tokens (${remaining.join(', ')}). Wipe all accounts (omit --account) or drop --regenerate-key.`,
      };
    }
  }
  const reauth = wipeAliases.filter((a) => state.tokenPresent(a));
  return { ok: true, plan: { wipeAliases, regenerateKey: opts.regenerateKey }, reauth };
}

function parseResetOptions(argv: string[]): ResetOptions {
  const at = argv.indexOf('--account');
  return {
    account: at >= 0 ? argv[at + 1] : undefined,
    regenerateKey: argv.includes('--regenerate-key'),
    yes: argv.includes('--yes'),
  };
}

async function confirmTty(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer: string = await new Promise((resolve) => rl.question(prompt, resolve));
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

/** CLI entry for `mcp-google-multi reset` (flags: --account, --regenerate-key,
 * --yes). Confirmation-gated; config.json is always kept. */
export async function runResetCli(argv: string[]): Promise<number> {
  const opts = parseResetOptions(argv);
  const set = (() => { try { return getAccountSet(); } catch { return null; } })();
  const aliases = set?.aliases ?? [];
  const planned = planReset(opts, { aliases, tokenPresent: (a) => hasToken(a) });
  if (!planned.ok) {
    console.error(`${planned.slug}: ${planned.message}`);
    return 1;
  }
  const { plan, reauth } = planned;

  const summary = `About to wipe tokens for: ${plan.wipeAliases.join(', ') || '(no accounts)'}` +
    (plan.regenerateKey ? ' AND regenerate the MASTER_KEY' : '') + '. config.json is kept.';

  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      console.error(`E_INPUT_REQUIRED: ${summary}\nRe-run with --yes to confirm (non-interactive).`);
      return 1;
    }
    const ok = await confirmTty(`${summary}\nType 'yes' to confirm: `);
    if (!ok) {
      console.error('confirmation_declined: nothing was changed.');
      return 1;
    }
  }

  // Execute: delete each alias's encrypted token file (config.json untouched).
  let wiped = 0;
  for (const alias of plan.wipeAliases) {
    const encPath = set?.configs[alias]?.encPath;
    if (!encPath) continue;
    try {
      fs.unlinkSync(encPath);
      wiped++;
    } catch {
      // already gone
    }
  }
  console.log(`Wiped ${wiped} token file(s).`);

  if (plan.regenerateKey) {
    const res = deleteMasterKeyMaterial();
    console.log(`MASTER_KEY material removed (file: ${res.file}, keychain: ${res.keychain}).`);
    if (res.env) console.log('Note: MASTER_KEY is still set in the environment; unset it to let a fresh key generate.');
  }

  if (reauth.length > 0) {
    console.log('\nNext, re-authenticate each wiped account:');
    for (const alias of reauth) console.log(`  npx mcp-google-multi auth --account ${alias}`);
  }
  return 0;
}

/** CLI entry for `mcp-google-multi doctor` (flags: --json, --strict, --report). */
export async function runDoctorCli(argv: string[], version: string): Promise<number> {
  const json = argv.includes('--json');
  const strict = argv.includes('--strict');
  const report = argv.includes('--report');
  const result = await runDiagnostics();
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (report) console.log(renderReport(result, version));
  else console.log(renderDoctorText(result));
  return exitCodeFor(result, strict);
}
