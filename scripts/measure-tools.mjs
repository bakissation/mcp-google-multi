// Measure the tools/list payload the server advertises, and gate CI on it.
// Lazy mode's whole promise is a small context footprint, so growth is a
// regression like any other (RQ2: the un-capped discover descriptions had
// silently reached ~11.5k est tokens before the 6.0.0 diet).
//
//   node scripts/measure-tools.mjs             print the measurement JSON
//   node scripts/measure-tools.mjs --check     fail (exit 1) when totalBytes
//                                              exceeds the committed baseline
//                                              by more than 10 percent
//   node scripts/measure-tools.mjs --update    rewrite the baseline (do this
//                                              deliberately, in the same PR
//                                              that justifies the growth)
//
// Requires a prior `npm run build`. Worst-case surface on purpose: every
// optional bundle enabled (read from the built scope catalog, so new bundles
// are measured automatically), GOOGLE_TOOLSETS=all, default lazy mode.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'dist', 'index.js');
const BASELINE = path.join(ROOT, 'tests', 'fixtures', 'lazy-bytes-baseline.json');
const GROWTH_BUDGET = 0.10;

const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--update') ? 'update' : 'print';

if (!fs.existsSync(ENTRY)) {
  console.error('dist/index.js not found: run `npm run build` first.');
  process.exit(2);
}

const { BUNDLE_CATALOG } = await import(path.join(ROOT, 'dist', 'scope-catalog.js'));
// The legacy global-scopes env is the one-line way to grant every bundle to a
// throwaway fixture process; the E_LEGACY stderr warning is expected and inert.
const bundles = Object.keys(BUNDLE_CATALOG).filter((b) => b !== 'admin').join(',');

const env = {
  ...process.env,
  GOOGLE_ACCOUNTS: 'example:user@example.com',
  GOOGLE_ADMIN_ACCOUNTS: 'example',
  GOOGLE_CLIENT_ID: 'measure',
  GOOGLE_CLIENT_SECRET: 'measure',
  MASTER_KEY: 'a'.repeat(64),
  TOKEN_STORE_PATH: fs.mkdtempSync(path.join(os.tmpdir(), 'gm-measure-')),
  GOOGLE_OPTIONAL_SCOPES: bundles,
  GOOGLE_TOOLSETS: 'all',
  GOOGLE_DISCOVERY: 'lazy',
};

const p = spawn(process.execPath, [ENTRY], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const tools = [];
const pending = new Map();
let nextId = 1;

function send(method, params, cb) {
  const id = cb ? nextId++ : undefined;
  if (cb) pending.set(id, cb);
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, params }) + '\n');
}

function listPage(cursor) {
  send('tools/list', cursor ? { cursor } : {}, (res) => {
    tools.push(...res.tools);
    if (res.nextCursor) listPage(res.nextCursor);
    else finish();
  });
}

function finish() {
  const rows = tools.map((t) => ({ name: t.name, bytes: Buffer.byteLength(JSON.stringify(t)) }));
  rows.sort((a, b) => b.bytes - a.bytes);
  const totalBytes = rows.reduce((s, r) => s + r.bytes, 0);
  const result = {
    toolCount: rows.length,
    totalBytes,
    estTokens: Math.round(totalBytes / 4),
    top10: rows.slice(0, 10),
  };
  p.kill();

  if (mode === 'update') {
    fs.writeFileSync(BASELINE, JSON.stringify({ toolCount: result.toolCount, totalBytes, estTokens: result.estTokens }, null, 2) + '\n');
    console.log(`baseline updated: ${totalBytes} bytes (${result.estTokens} est tokens, ${result.toolCount} tools)`);
    process.exit(0);
  }
  if (mode === 'check') {
    const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf-8'));
    const limit = Math.round(baseline.totalBytes * (1 + GROWTH_BUDGET));
    const verdict = totalBytes <= limit ? 'OK' : 'FAIL';
    console.log(`lazy tools/list: ${totalBytes} bytes (${result.estTokens} est tokens, ${result.toolCount} tools); baseline ${baseline.totalBytes}, budget ${limit}: ${verdict}`);
    if (verdict === 'FAIL') {
      console.error(`lazy tools/list grew past the ${GROWTH_BUDGET * 100} percent budget. Shrink the surface, or update the baseline IN THIS PR with \`node scripts/measure-tools.mjs --update\` and justify it.`);
      process.exit(1);
    }
    process.exit(0);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

p.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const cb = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) {
        console.error('RPC error:', JSON.stringify(msg.error));
        p.kill();
        process.exit(1);
      }
      cb(msg.result);
    }
  }
});
p.stderr.on('data', () => {});
p.on('exit', (code) => {
  if (pending.size > 0) {
    console.error(`server exited (code ${code}) before answering`);
    process.exit(1);
  }
});

send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'measure', version: '0.0.0' } }, () => {
  send('notifications/initialized', {});
  listPage();
});
setTimeout(() => {
  console.error('timeout waiting for tools/list');
  p.kill();
  process.exit(1);
}, 30_000).unref?.();
