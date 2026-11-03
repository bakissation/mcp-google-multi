import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { McpServer, PROTOCOL_VERSION_META_KEY, CLIENT_INFO_META_KEY, CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { resolveHttpConfig } from '../src/http-config.js';
import { HttpTransportHost, type ServerTarget } from '../src/http-transport.js';
import {
  ConfirmTokens,
  HttpConfirm,
  CONFIRM_TOKEN_META,
  callHash,
  confirmTokenEnabled,
  liftConfirmToken,
} from '../src/http-confirm.js';

const KEY = Buffer.alloc(32, 7);

describe('ConfirmTokens', () => {
  it('accepts a token once for the call it was minted for', () => {
    const t = new ConfirmTokens(KEY, 300);
    const h = callHash({ a: 1 }, 'alice');
    const { token } = t.mint(h);
    expect(t.consume(token, h)).toEqual({ ok: true });
    expect(t.consume(token, h)).toEqual({ ok: false, reason: 'used' });
  });

  it('refuses an expired token', () => {
    let now = 1_000_000;
    const t = new ConfirmTokens(KEY, 60, () => now);
    const h = callHash({ a: 1 }, 'alice');
    const { token } = t.mint(h);
    now += 61_000;
    expect(t.consume(token, h)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a token for a different call or a different subject, and does not spend it', () => {
    const t = new ConfirmTokens(KEY, 300);
    const h = callHash({ a: 1 }, 'alice');
    const { token } = t.mint(h);
    expect(t.consume(token, callHash({ a: 2 }, 'alice'))).toEqual({ ok: false, reason: 'mismatch' });
    expect(t.consume(token, callHash({ a: 1 }, 'bob'))).toEqual({ ok: false, reason: 'mismatch' });
    expect(t.consume(token, h)).toEqual({ ok: true });
  });

  it('refuses tampered, foreign-key and malformed tokens', () => {
    const t = new ConfirmTokens(KEY, 300);
    const h = callHash({ a: 1 }, 'alice');
    const { token } = t.mint(h);
    expect(t.consume(`${token}x`, h)).toEqual({ ok: false, reason: 'malformed' });
    expect(t.consume('nonsense', h)).toEqual({ ok: false, reason: 'malformed' });
    const other = new ConfirmTokens(Buffer.alloc(32, 9), 300);
    expect(other.consume(token, h)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('hashes a call independent of key order', () => {
    expect(callHash({ a: 1, b: { c: 2, d: 3 } }, 's')).toBe(callHash({ b: { d: 3, c: 2 }, a: 1 }, 's'));
  });
});

describe('confirmTokenEnabled', () => {
  it('is off unless explicitly turned on', () => {
    expect(confirmTokenEnabled({})).toBe(false);
    expect(confirmTokenEnabled({ MCP_HTTP_CONFIRM_TOKEN: '0' })).toBe(false);
    expect(confirmTokenEnabled({ MCP_HTTP_CONFIRM_TOKEN: '1' })).toBe(true);
    expect(confirmTokenEnabled({ MCP_HTTP_CONFIRM_TOKEN: 'ON' })).toBe(true);
  });
});

describe('liftConfirmToken', () => {
  it('moves the token from arguments into _meta and leaves other frames alone', () => {
    const lifted = liftConfirmToken({ method: 'tools/call', params: { name: 'x', arguments: { a: 1, confirmToken: 'c1.t' } } }) as {
      params: { arguments: Record<string, unknown>; _meta: Record<string, unknown> };
    };
    expect(lifted.params.arguments).toEqual({ a: 1 });
    expect(lifted.params._meta[CONFIRM_TOKEN_META]).toBe('c1.t');
    const other = { method: 'tools/list', params: {} };
    expect(liftConfirmToken(other)).toBe(other);
    const plain = { method: 'tools/call', params: { name: 'x', arguments: { a: 1 } } };
    expect(liftConfirmToken(plain)).toBe(plain);
  });
});

// ---- over the real host ---------------------------------------------------

const hosts: HttpTransportHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

const MCP_ACCEPT = 'application/json, text/event-stream';

const probe = { active: 0, peak: 0 };

/** A server with one write-like tool that asks HttpConfirm before acting. */
function makeServer(confirm: HttpConfirm, sent: string[]): McpServer {
  const s = new McpServer({ name: 'confirm-test', version: '0.0.0' });
  s.registerTool('write', { description: 'a guarded write', inputSchema: z.object({ target: z.string() }) }, async ({ target }, ctx) => {
    const outcome = await confirm.confirm(ctx, `Write to ${target}`, { target }, 'default');
    if (outcome.action === 'respond') return outcome.result as never;
    if (outcome.action !== 'accept') {
      const error = outcome.action === 'unavailable' ? 'elicitation_unsupported' : 'write_declined';
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error }) }], isError: true };
    }
    sent.push(target);
    return { content: [{ type: 'text' as const, text: 'written' }] };
  });
  s.registerTool('slow', { description: 'tracks overlap', inputSchema: z.object({}) }, async () => {
    probe.active++;
    probe.peak = Math.max(probe.peak, probe.active);
    await new Promise((r) => setTimeout(r, 60));
    probe.active--;
    return { content: [{ type: 'text' as const, text: 'done' }] };
  });
  s.registerTool('hang', { description: 'outlives the deadline', inputSchema: z.object({}) }, async () => {
    await new Promise((r) => {
      const t = setTimeout(r, 3000);
      t.unref?.();
    });
    return { content: [{ type: 'text' as const, text: 'late' }] };
  });
  return s;
}

async function startHost(tokens: boolean, sent: string[], extra: { dispatchTimeoutMs?: number } = {}): Promise<number> {
  const confirm = new HttpConfirm({ tokens, env: {} });
  const config = { ...resolveHttpConfig({ MCP_TRANSPORT: 'http' }), port: 0 };
  const modern = (): ServerTarget => ({ server: makeServer(confirm, sent) });
  const host = new HttpTransportHost({
    server: makeServer(confirm, sent),
    config,
    version: '9.9.9',
    ownerConfigured: true,
    authenticate: () => ({ ok: true, sub: 'alice' }),
    modern,
    confirmToken: tokens,
    ...extra,
  });
  await host.start();
  hosts.push(host);
  return host.address()!.port;
}

function post(port: number, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    // The modern wire repeats its protocol version in a header, and the SDK checks they agree.
    const version = (body as { params?: { _meta?: Record<string, unknown> } }).params?._meta?.[PROTOCOL_VERSION_META_KEY];
    if (typeof version === 'string') {
      const b = body as { method: string; params: { name?: string } };
      headers = { 'mcp-protocol-version': version, 'mcp-method': b.method, ...(b.params.name ? { 'mcp-name': b.params.name } : {}), ...headers };
    }
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path: '/mcp',
        headers: { host: '127.0.0.1', accept: MCP_ACCEPT, 'content-type': 'application/json', 'content-length': String(data.length), ...headers },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: { raw: text } });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const legacyCall = (args: Record<string, unknown>, id = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'write', arguments: args },
});

const modernCall = (extra: Record<string, unknown> = {}, args: Record<string, unknown> = { target: 'doc-1' }, elicit = true) => ({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: {
    name: 'write',
    arguments: args,
    _meta: {
      [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
      [CLIENT_INFO_META_KEY]: { name: 'test-client', version: '1.2.3' },
      [CLIENT_CAPABILITIES_META_KEY]: elicit ? { elicitation: {} } : {},
    },
    ...extra,
  },
});

const textOf = (json: Record<string, unknown>): string =>
  ((json.result as { content?: Array<{ text: string }> } | undefined)?.content?.[0]?.text ?? '') as string;

describe('legacy wire, confirm token off (today\'s behaviour)', () => {
  it('refuses with the plain unavailable result and never acts', async () => {
    const sent: string[] = [];
    const port = await startHost(false, sent);
    const r = await post(port, legacyCall({ target: 'doc-1' }));
    expect(JSON.parse(textOf(r.json)).error).toBe('elicitation_unsupported');
    expect(sent).toEqual([]);
  });

  it('does not accept a confirmToken argument as anything special', async () => {
    const sent: string[] = [];
    const port = await startHost(false, sent);
    const r = await post(port, legacyCall({ target: 'doc-1', confirmToken: 'c1.x.y' }));
    expect(sent).toEqual([]);
    expect(r.status).toBe(200);
  });
});

describe('legacy wire, confirm token on', () => {
  it('walks refuse, retry with the token, act once, and refuses a replay', async () => {
    const sent: string[] = [];
    const port = await startHost(true, sent);
    const first = JSON.parse(textOf((await post(port, legacyCall({ target: 'doc-1' }))).json));
    expect(first.error).toBe('confirmation_required');
    expect(first.summary).toBe('Write to doc-1');
    expect(typeof first.confirmToken).toBe('string');
    expect(sent).toEqual([]);

    const second = await post(port, legacyCall({ target: 'doc-1', confirmToken: first.confirmToken }, 2));
    expect(textOf(second.json)).toBe('written');
    expect(sent).toEqual(['doc-1']);

    const replay = JSON.parse(textOf((await post(port, legacyCall({ target: 'doc-1', confirmToken: first.confirmToken }, 3))).json));
    expect(replay.error).toBe('confirmation_invalid');
    expect(sent).toEqual(['doc-1']);
  });

  it('refuses a token presented with different arguments', async () => {
    const sent: string[] = [];
    const port = await startHost(true, sent);
    const first = JSON.parse(textOf((await post(port, legacyCall({ target: 'doc-1' }))).json));
    const other = JSON.parse(textOf((await post(port, legacyCall({ target: 'doc-2', confirmToken: first.confirmToken }, 2))).json));
    expect(other.error).toBe('confirmation_invalid');
    expect(sent).toEqual([]);
  });
});

describe('modern wire', () => {
  it('asks for input, then acts once the retry carries an accepted answer for the same call', async () => {
    const sent: string[] = [];
    const port = await startHost(false, sent);
    const first = await post(port, modernCall());
    const result = first.json.result as { resultType?: string; inputRequests?: Record<string, unknown>; requestState?: string };
    expect(result.resultType).toBe('input_required');
    expect(Object.keys(result.inputRequests ?? {})).toEqual(['confirm']);
    expect(sent).toEqual([]);

    const retry = await post(
      port,
      modernCall({ inputResponses: { confirm: { action: 'accept', content: {} } }, requestState: result.requestState }),
    );
    expect(textOf(retry.json)).toBe('written');
    expect(sent).toEqual(['doc-1']);
  });

  it('a declined answer never acts and reads as a decline', async () => {
    const sent: string[] = [];
    const port = await startHost(false, sent);
    const result = (await post(port, modernCall())).json.result as { requestState?: string };
    const retry = await post(port, modernCall({ inputResponses: { confirm: { action: 'decline' } }, requestState: result.requestState }));
    expect(JSON.parse(textOf(retry.json)).error).toBe('write_declined');
    expect(sent).toEqual([]);
  });

  it('refuses an accepted answer carried to a different call', async () => {
    const sent: string[] = [];
    const port = await startHost(false, sent);
    const result = (await post(port, modernCall())).json.result as { requestState?: string };
    const retry = await post(
      port,
      modernCall({ inputResponses: { confirm: { action: 'accept', content: {} } }, requestState: result.requestState }, { target: 'doc-2' }),
    );
    expect(JSON.parse(textOf(retry.json)).error).toBe('confirmation_invalid');
    expect(sent).toEqual([]);
  });

  it('a modern client that cannot elicit gets the same refusal as before when tokens are off', async () => {
    const sent: string[] = [];
    const port = await startHost(false, sent);
    const r = await post(port, modernCall({}, { target: 'doc-1' }, false));
    expect(JSON.parse(textOf(r.json)).error).toBe('elicitation_unsupported');
    expect(sent).toEqual([]);
  });

  it('serves both eras on one host, alternating', async () => {
    const sent: string[] = [];
    const port = await startHost(true, sent);
    for (let i = 0; i < 3; i++) {
      const l = JSON.parse(textOf((await post(port, legacyCall({ target: 'doc-1' }, 10 + i))).json));
      expect(l.error).toBe('confirmation_required');
      const m = (await post(port, modernCall({}, { target: 'doc-1' }))).json.result as { resultType?: string };
      expect(m.resultType).toBe('input_required');
    }
  });
});

describe('modern lane keeps the host\'s guarantees', () => {
  const plain = (id: number, name: string) => {
    const c = modernCall({}, {});
    return { ...c, id, params: { ...c.params, name, arguments: {} } };
  };

  it('never runs two calls on a lane at once, across both wire eras', async () => {
    probe.active = 0;
    probe.peak = 0;
    const port = await startHost(false, []);
    const legacy = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'slow', arguments: {} } });
    const all = await Promise.all([post(port, plain(1, 'slow')), post(port, legacy(2)), post(port, plain(3, 'slow')), post(port, legacy(4))]);
    for (const r of all) expect(r.status).toBe(200);
    expect(probe.peak).toBe(1);
  });

  it('answers 504 when a modern call outlives the dispatch deadline, and the lane serves on', async () => {
    const port = await startHost(false, [], { dispatchTimeoutMs: 150 });
    const hung = await post(port, plain(1, 'hang'));
    expect(hung.status).toBe(504);
    expect(hung.json.error).toBe('dispatch_timeout');
    const next = await post(port, plain(2, 'slow'));
    expect(next.status).toBe(200);
  });
});
