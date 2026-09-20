import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { tapUsageMetrics } from '../src/metrics-tap.js';
import { Metrics } from '../src/usage-metrics.js';
import { normalizeMessage } from '../src/arg-normalize.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeMetrics() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-tap-'));
  dirs.push(d);
  const dir = path.join(d, 'metrics');
  const m = new Metrics({ dir, version: 'v', mode: 'lazy', transport: 'stdio', log: () => {} });
  return { m, dir };
}

function fakeTransport() {
  const sent: JSONRPCMessage[] = [];
  const t = {
    start: async () => {},
    send: async (msg: JSONRPCMessage) => { sent.push(msg); },
    close: async () => {},
    onmessage: undefined as ((msg: JSONRPCMessage) => void) | undefined,
  };
  return { t: t as unknown as Transport, sent };
}

function readDay(dir: string): Record<string, any> {
  const f = fs.readdirSync(path.join(dir, 'agg')).find((x) => x.endsWith('.json'))!;
  return JSON.parse(fs.readFileSync(path.join(dir, 'agg', f), 'utf-8'));
}

const call = (id: number, name: string): JSONRPCMessage =>
  ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } }) as JSONRPCMessage;
const errFrame = (id: number, code: number, message: string): JSONRPCMessage =>
  ({ jsonrpc: '2.0', id, error: { code, message } }) as JSONRPCMessage;

function drive(m: Metrics) {
  const { t } = fakeTransport();
  const tapped = tapUsageMetrics(t, m);
  const seen: JSONRPCMessage[] = [];
  tapped.onmessage = (msg: JSONRPCMessage) => seen.push(msg);
  const inbound = (msg: JSONRPCMessage) => (t as unknown as { onmessage: (m: JSONRPCMessage) => void }).onmessage(msg);
  return { tapped, inbound, seen };
}

describe('tapUsageMetrics', () => {
  it('a -32602 schema rejection attributes the registered tool name', async () => {
    const { m, dir } = makeMetrics();
    const { tapped, inbound, seen } = drive(m);
    inbound(call(1, 'tasks_update'));
    await tapped.send(errFrame(1, -32602, 'Input validation error: Invalid arguments for tool tasks_update'));
    m.flush();
    expect(readDay(dir).validation).toEqual({ tasks_update: 1 });
    expect(seen).toHaveLength(1);
  });

  it('an unknown-tool -32602 counts tool_not_found and never records the client-typed name', async () => {
    const { m, dir } = makeMetrics();
    const { tapped, inbound } = drive(m);
    inbound(call(2, 'EVIL@name'));
    await tapped.send(errFrame(2, -32602, 'MCP error -32602: Unknown tool: EVIL@name'));
    m.flush();
    const day = readDay(dir);
    expect(day.rpc.tool_not_found).toBe(1);
    expect(JSON.stringify(day)).not.toContain('EVIL');
  });

  it('other codes hit the closed rpc enumeration', async () => {
    const { m, dir } = makeMetrics();
    const { tapped } = drive(m);
    await tapped.send(errFrame(3, -32601, 'Method not found'));
    await tapped.send(errFrame(4, -31999, 'weird'));
    m.flush();
    expect(readDay(dir).rpc).toEqual({ 'rpc_error_-32601': 1, rpc_error_other: 1 });
  });

  it('an SDK-synthesized -32602 isError RESULT counts as schema_validation (SDK 1.x shape)', async () => {
    const { m, dir } = makeMetrics();
    const { tapped, inbound } = drive(m);
    inbound(call(7, 'tasks_update'));
    await tapped.send({
      jsonrpc: '2.0', id: 7,
      result: { isError: true, content: [{ type: 'text', text: 'MCP error -32602: Input validation error: Invalid arguments for tool tasks_update' }] },
    } as unknown as JSONRPCMessage);
    m.flush();
    expect(readDay(dir).validation).toEqual({ tasks_update: 1 });
  });

  it('a handler isError envelope on the send path counts nothing here', async () => {
    const { m, dir } = makeMetrics();
    const { tapped, inbound } = drive(m);
    inbound(call(8, 'gmail_search'));
    await tapped.send({
      jsonrpc: '2.0', id: 8,
      result: { isError: true, content: [{ type: 'text', text: '{"error":"not_found","message":"x","retriable":false,"account":"a"}' }] },
    } as unknown as JSONRPCMessage);
    m.flush();
    const day = readDay(dir);
    expect(day.validation).toEqual({});
    expect(day.rpc).toEqual({});
  });

  it('result frames count nothing (the registry wrapper owns handler results)', async () => {
    const { m, dir } = makeMetrics();
    const { tapped, inbound } = drive(m);
    inbound(call(5, 'gmail_search'));
    await tapped.send({ jsonrpc: '2.0', id: 5, result: { content: [] } } as unknown as JSONRPCMessage);
    m.flush();
    expect(fs.existsSync(path.join(dir, 'agg'))).toBe(true);
    const day = readDay(dir);
    expect(day.validation).toEqual({});
    expect(day.rpc).toEqual({});
  });
});

describe('normalizeMessage onRename observer', () => {
  const shape = new Map([['maxResults', 'number' as const]]);
  const msg = (args: Record<string, unknown>): JSONRPCMessage =>
    ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'gmail_search', arguments: args } }) as JSONRPCMessage;

  it('fires with the tool name and rename count', () => {
    const calls: [string, number][] = [];
    normalizeMessage(msg({ max_results: '5' }), () => shape, () => {}, (tool, n) => calls.push([tool, n]));
    expect(calls).toEqual([['gmail_search', 1]]);
  });

  it('a throwing observer never breaks normalization', () => {
    const out = normalizeMessage(msg({ max_results: '5' }), () => shape, () => {}, () => { throw new Error('boom'); });
    expect((out as { params: { arguments: Record<string, unknown> } }).params.arguments.maxResults).toBe(5);
  });

  it('does not fire when nothing renamed', () => {
    let fired = 0;
    normalizeMessage(msg({ maxResults: 5 }), () => shape, () => {}, () => { fired += 1; });
    expect(fired).toBe(0);
  });
});
