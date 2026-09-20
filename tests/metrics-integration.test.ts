import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcIndex = path.join(repoRoot, 'src', 'index.ts');

// End-to-end over real stdio (spec section 7): tsx against src, fixture
// registry, no tokens, temp metrics dir. Slow by nature; one boot per case.
function baseEnv(home: string): NodeJS.ProcessEnv {
  const emptyEnv = path.join(home, 'empty.env');
  writeFileSync(emptyEnv, '');
  const env = { ...process.env } as NodeJS.ProcessEnv;
  for (const k of ['GOOGLE_USAGE_METRICS', 'USAGE_METRICS_PATH', 'GOOGLE_OPTIONAL_SCOPES', 'GOOGLE_DEFAULT_ACCOUNT']) delete env[k];
  env.XDG_CONFIG_HOME = home;
  env.XDG_STATE_HOME = path.join(home, 'state');
  env.TOKEN_STORE_PATH = path.join(home, 'tokens');
  env.MCP_GOOGLE_MULTI_ENV = emptyEnv;
  env.GOOGLE_ACCOUNTS = 'example:user@example.com';
  env.GOOGLE_CLIENT_ID = 'it';
  env.GOOGLE_CLIENT_SECRET = 'it';
  env.MASTER_KEY = 'a'.repeat(64);
  env.GOOGLE_DISCOVERY = 'curated';
  return env;
}

function rpc(id: number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

/** Boot the stdio server, run the messages, then END STDIN after the last
 * response: the event loop drains (the flush timer is unref'd) and the
 * process exits through the `exit` flush hook. Signal-free on purpose:
 * Windows' SIGTERM emulation kills without running handlers. */
function runSession(env: NodeJS.ProcessEnv, messages: string[]): Promise<void> {
  const expected = messages.filter((m) => m.includes('"id"')).length;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', 'tsx', srcIndex], { cwd: repoRoot, env });
    let responses = 0;
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        responses += 1;
        if (responses === expected) p.stdin.end();
      }
    });
    p.on('exit', () => resolve());
    p.on('error', reject);
    p.stdin.write(messages.join(''));
    setTimeout(() => { p.kill('SIGKILL'); reject(new Error('session timeout')); }, 50_000).unref?.();
  });
}

const initialized = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n';

describe('metrics end-to-end (stdio)', () => {
  it('off is off: 3 dispatches create no state dir and no metrics dir', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'gm-mi-off-'));
    const env = baseEnv(home);
    await runSession(env, [
      rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }),
      initialized,
      rpc(2, 'tools/call', { name: 'account_list', arguments: {} }),
      rpc(3, 'tools/call', { name: 'gmail_search', arguments: { account: 'example', query: 'x' } }),
    ]);
    expect(existsSync(path.join(home, 'state'))).toBe(false);
  }, 60_000);

  it('on: dispatches land in the day file with tool counts, slugs and validation; report --json round-trips', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'gm-mi-on-'));
    const env = baseEnv(home);
    env.GOOGLE_USAGE_METRICS = 'on';
    await runSession(env, [
      rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }),
      initialized,
      rpc(2, 'tools/call', { name: 'account_list', arguments: {} }),
      rpc(3, 'tools/call', { name: 'gmail_search', arguments: { account: 'example', query: 'x' } }),
      rpc(4, 'tools/call', { name: 'tasks_update', arguments: { account: 'example' } }),
    ]);
    const aggDir = path.join(home, 'state', 'mcp-google-multi', 'metrics', 'agg');
    const dayFile = readdirSync(aggDir).find((f) => f.endsWith('.json'))!;
    const day = JSON.parse(readFileSync(path.join(aggDir, dayFile), 'utf-8'));
    expect(day.tools.account_list.n).toBe(1);
    expect(day.tools.gmail_search.n).toBe(1);
    // no token stored: the gmail call fails through the error taxonomy with a slug
    expect(Object.keys(day.tools.gmail_search.err).length).toBe(1);
    // bad-args tasks_update never reached a handler: schema_validation via the tap
    expect(day.validation.tasks_update).toBe(1);

    const r = spawnSync(process.execPath, ['--import', 'tsx', srcIndex, 'metrics', 'report', '--json'], {
      cwd: repoRoot, env, input: '', encoding: 'utf8', timeout: 60_000,
    });
    const parsed = JSON.parse(String(r.stdout).trim().split('\n').pop()!);
    expect(parsed.agg.tools.gmail_search.n).toBe(1);
  }, 60_000);
});
