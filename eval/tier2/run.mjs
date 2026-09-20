// Tier-2 agent eval (eval harness check 3 of 3): scripted real-account tasks
// driven through Claude Code headless, scoring FIRST-CALL tool selection,
// first-try success, turns and token spend. Runs PER RELEASE by the operator
// (never CI: it needs a real authenticated instance and spends real tokens).
//
//   node eval/tier2/run.mjs --mcp-config <file> [--runs 3] [--only id,id]
//                           [--model sonnet] [--out eval/tier2/out]
//                           [--baseline <prior-summary.json>]
//
// The MCP config is the operator's own (e.g. {"mcpServers":{"gmulti":{
// "command":"~/.local/bin/mcp-google-multi-run"}}}). Tasks are read-only by
// design and safe under GOOGLE_PROFILE=read-only. Only mcp__gmulti__* tools
// are allowed, so the agent cannot answer through anything else.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const mcpConfig = arg('mcp-config');
if (!mcpConfig) {
  console.error('usage: node eval/tier2/run.mjs --mcp-config <file> [--runs 3] [--only id,...] [--baseline <file>]');
  process.exit(2);
}
const runs = Number(arg('runs', '3'));
const model = arg('model', 'sonnet');
const outDir = arg('out', path.join(HERE, 'out'));
const only = arg('only', '')?.split(',').filter(Boolean);
const baselineFile = arg('baseline');

const { tasks } = JSON.parse(fs.readFileSync(path.join(HERE, 'tasks.json'), 'utf-8'));
const selected = only.length > 0 ? tasks.filter((t) => only.includes(t.id)) : tasks;

// Neutral cwd so no project CLAUDE.md or settings leak into the eval context;
// --strict-mcp-config so ONLY the eval server loads (without it the user's
// whole personal MCP fleet joins and poisons tool selection).
const evalCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-tier2-cwd-'));

function runOnce(task) {
  const started = Date.now();
  const r = spawnSync('claude', [
    '-p', task.prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--mcp-config', mcpConfig,
    '--strict-mcp-config',
    '--allowedTools', 'mcp__gmulti__*',
    '--model', model,
    '--max-turns', '8',
  ], { encoding: 'utf8', timeout: 240_000, input: '', cwd: evalCwd });
  const events = String(r.stdout ?? '').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  const toolCalls = [];
  const toolResults = new Map();
  let usage = { input_tokens: 0, output_tokens: 0 };
  let finalText = '';
  let runErrored = r.status !== 0;
  for (const e of events) {
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c.type === 'tool_use') toolCalls.push({ id: c.id, name: String(c.name).replace(/^mcp__.*?__/, '') });
      }
    }
    if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c.type === 'tool_result') toolResults.set(c.tool_use_id, c.is_error !== true);
      }
    }
    if (e.type === 'result') {
      // The result event carries the authoritative aggregate usage.
      finalText = e.result ?? '';
      runErrored = runErrored || e.is_error === true;
      usage.input_tokens = e.usage?.input_tokens ?? 0;
      usage.output_tokens = e.usage?.output_tokens ?? 0;
    }
  }

  const firstTool = toolCalls[0]?.name;
  const firstCallOk = task.expectFirst.includes(firstTool);
  const success = !runErrored
    && toolCalls.some((c) => task.successTools.includes(c.name) && toolResults.get(c.id) === true)
    && finalText.length > 0;
  return {
    firstTool: firstTool ?? null,
    firstCallOk,
    success,
    toolCalls: toolCalls.map((c) => c.name),
    turns: toolCalls.length,
    tokens: usage,
    ms: Date.now() - started,
    exit: r.status,
  };
}

const results = [];
for (const task of selected) {
  for (let i = 0; i < runs; i++) {
    process.stderr.write(`${task.id} run ${i + 1}/${runs}...\n`);
    results.push({ task: task.id, run: i + 1, ...runOnce(task) });
  }
}

const byTask = {};
for (const t of selected) {
  const rs = results.filter((r) => r.task === t.id);
  byTask[t.id] = {
    firstCallRate: rs.filter((r) => r.firstCallOk).length / rs.length,
    successRate: rs.filter((r) => r.success).length / rs.length,
    avgTokens: Math.round(rs.reduce((s, r) => s + r.tokens.input_tokens + r.tokens.output_tokens, 0) / rs.length),
    avgToolCalls: Math.round((rs.reduce((s, r) => s + r.turns, 0) / rs.length) * 10) / 10,
    firstTools: [...new Set(rs.map((r) => r.firstTool))],
  };
}
const overall = {
  firstCallRate: results.filter((r) => r.firstCallOk).length / results.length,
  successRate: results.filter((r) => r.success).length / results.length,
  totalTokens: results.reduce((s, r) => s + r.tokens.input_tokens + r.tokens.output_tokens, 0),
};
const summary = { v: 1, when: new Date().toISOString(), model, runs, overall, byTask, results };

fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `tier2-${new Date().toISOString().slice(0, 10)}.json`);
fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));

console.log(`tier-2: first-call ${(overall.firstCallRate * 100).toFixed(0)}%  success ${(overall.successRate * 100).toFixed(0)}%  tokens ${overall.totalTokens}  -> ${outFile}`);
for (const [id, s] of Object.entries(byTask)) {
  console.log(`  ${id.padEnd(20)} first ${(s.firstCallRate * 100).toFixed(0).padStart(3)}%  ok ${(s.successRate * 100).toFixed(0).padStart(3)}%  ~${s.avgTokens} tok  first=[${s.firstTools.join(',')}]`);
}

if (baselineFile) {
  const base = JSON.parse(fs.readFileSync(baselineFile, 'utf-8'));
  const dFirst = overall.firstCallRate - base.overall.firstCallRate;
  const dSuccess = overall.successRate - base.overall.successRate;
  console.log(`vs baseline: first-call ${(dFirst * 100).toFixed(0)}pt  success ${(dSuccess * 100).toFixed(0)}pt`);
  if (dFirst < -0.1 || dSuccess < -0.1) {
    console.error('REGRESSION: a rate dropped more than 10 points vs the baseline.');
    process.exit(1);
  }
}
