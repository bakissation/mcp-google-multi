import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { McpServer } from "@modelcontextprotocol/server";
import { resolveHttpConfig } from '../src/http-config.js';
import {
  HttpTransportHost,
  parseOwnerEmails,
  originAllowed,
  hostAllowed,
  jsonRpcMethod,
  type Authenticator,
  type HttpHostOptions,
} from '../src/http-transport.js';
import { z } from "zod";

// ---- pure helpers -----------------------------------------------------------

describe('http-transport pure helpers', () => {
  it('parseOwnerEmails: CSV, trims, lowercases, drops blanks', () => {
    expect(parseOwnerEmails({ MCP_OWNER_EMAILS: ' Me@Ex.com , you@ex.com , ' })).toEqual(['me@ex.com', 'you@ex.com']);
    expect(parseOwnerEmails({})).toEqual([]);
  });

  it('originAllowed: absent passes, present must be allowlisted', () => {
    expect(originAllowed(undefined, ['https://claude.ai'])).toBe(true);
    expect(originAllowed('https://claude.ai', ['https://claude.ai'])).toBe(true);
    expect(originAllowed('https://evil.example', ['https://claude.ai'])).toBe(false);
  });

  it('hostAllowed: exact or bare hostname, port-agnostic', () => {
    const allowed = ['mcp.example.com', '127.0.0.1:4243', '127.0.0.1'];
    expect(hostAllowed('mcp.example.com', allowed)).toBe(true);
    expect(hostAllowed('127.0.0.1:4243', allowed)).toBe(true);
    expect(hostAllowed('127.0.0.1:9999', allowed)).toBe(true); // bare match
    expect(hostAllowed('evil.example', allowed)).toBe(false);
    expect(hostAllowed(undefined, allowed)).toBe(false);
    expect(hostAllowed('anything', [])).toBe(true); // no allowlist configured
  });

  it('jsonRpcMethod: method name only, batch-aware, never throws on junk', () => {
    expect(jsonRpcMethod({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { secret: 'x' } })).toBe('tools/call');
    expect(jsonRpcMethod([{ method: 'a' }, { method: 'b' }])).toBe('a,b');
    expect(jsonRpcMethod({})).toBe('unknown');
    expect(jsonRpcMethod(null)).toBe('unknown');
    expect(jsonRpcMethod('nonsense')).toBe('unknown');
  });

});

// ---- integration: real McpServer over the host (BV-3) ------------------------

const hosts: HttpTransportHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

function makeServer(): McpServer {
  const s = new McpServer({ name: 'test-http', version: '0.0.0' });
  s.registerTool('ping', { description: 'ping the server', inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text' as const, text: 'pong' }],
  }));
  s.registerTool('whoami', { description: 'echo the authenticated subject', inputSchema: z.object({}) }, async (_args, ctx) => ({
    content: [{ type: 'text' as const, text: String((ctx.http?.authInfo?.extra as { sub?: string } | undefined)?.sub ?? 'none') }],
  }));
  s.registerTool('slow', { description: 'slow tool', inputSchema: z.object({}) }, async () => {
    await new Promise((r) => setTimeout(r, 300));
    return { content: [{ type: 'text' as const, text: 'done' }] };
  });
  s.registerTool('hang', { description: 'never settles within a test', inputSchema: z.object({}) }, async () => {
    // unref so the pending timer can't keep the process alive after the test.
    await new Promise((r) => {
      const t = setTimeout(r, 5000);
      t.unref?.();
    });
    return { content: [{ type: 'text' as const, text: 'unreachable' }] };
  });
  return s;
}

async function startHost(
  authenticate: Authenticator = () => ({ ok: true }),
  extra: Partial<Omit<HttpHostOptions, 'server' | 'config' | 'authenticate'>> = {},
): Promise<number> {
  const config = { ...resolveHttpConfig({ MCP_TRANSPORT: 'http' }), port: 0 };
  const host = new HttpTransportHost({ server: makeServer(), config, version: '9.9.9', ownerConfigured: true, authenticate, ...extra });
  await host.start();
  hosts.push(host);
  return host.address()!.port;
}

function request(
  port: number,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown; raw?: string; signal?: AbortSignal; agent?: http.Agent } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const data =
      opts.raw !== undefined ? Buffer.from(opts.raw) : opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body)) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        signal: opts.signal,
        agent: opts.agent,
        headers: {
          host: '127.0.0.1', // an allowlisted bare host
          ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const MCP_ACCEPT = 'application/json, text/event-stream';
const initBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
};

describe('HttpTransportHost (BV-3: stateless dispatch)', () => {
  // Every frame of a batch is screened synchronously in one tick, so an
  // uncapped batch multiplied any per-call cost by the frames in one body.
  it('refuses a JSON-RPC batch above the frame cap before dispatching any of it', async () => {
    const port = await startHost();
    const frame = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'ping', arguments: {} } });
    const big = await request(port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: Array.from({ length: 17 }, (_, i) => frame(i)) });
    expect(big.status).toBe(400);
    expect(JSON.parse(big.text).error).toBe('batch_too_large');
    const small = await request(port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: [initBody] });
    expect(small.status).not.toBe(400);
    const atCap = await request(port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: Array.from({ length: 16 }, (_, i) => frame(i)) });
    expect(atCap.status).not.toBe(400);
  });

  it('POST /mcp initialize returns a JSON-RPC result', async () => {
    const port = await startHost();
    const res = await request(port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: initBody });
    expect(res.status).toBe(200);
    const json = JSON.parse(res.text);
    expect(json.jsonrpc).toBe('2.0');
    expect(json.result.serverInfo.name).toBe('test-http');
  });

  it('POST /mcp tools/list advertises registered tools', async () => {
    const port = await startHost();
    await request(port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: initBody });
    const res = await request(port, 'POST', '/mcp', {
      headers: { accept: MCP_ACCEPT },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    });
    expect(res.status).toBe(200);
    const json = JSON.parse(res.text);
    const names = (json.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain('ping');
  });

  it('stamps the authenticated sub into ctx.http.authInfo.extra for tool handlers (S1.4)', async () => {
    const port = await startHost(() => ({ ok: true, sub: 'tenant-42' }));
    await request(port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: initBody });
    const res = await request(port, 'POST', '/mcp', {
      headers: { accept: MCP_ACCEPT },
      body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text).result.content[0].text).toBe('tenant-42');
  });

  it('defaults the stamped sub to owner when the authenticator carries none', async () => {
    const port = await startHost(); // default authenticator returns a bare {ok: true}
    await request(port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: initBody });
    const res = await request(port, 'POST', '/mcp', {
      headers: { accept: MCP_ACCEPT },
      body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text).result.content[0].text).toBe('owner');
  });

  it('resolveServer routes two subjects to two distinct servers (S1.15)', async () => {
    const named = (marker: string) => {
      const s = new McpServer({ name: `srv-${marker}`, version: '0.0.0' });
      s.registerTool('marker', { description: 'which server am I', inputSchema: z.object({}) }, async () => ({
        content: [{ type: 'text' as const, text: marker }],
      }));
      return s;
    };
    const servers: Record<string, McpServer> = { 'tenant-a': named('A'), 'tenant-b': named('B') };
    const config = { ...resolveHttpConfig({ MCP_TRANSPORT: 'http' }), port: 0 };
    const host = new HttpTransportHost({
      server: makeServer(),
      config,
      version: '9.9.9',
      ownerConfigured: true,
      authenticate: (req) => ({ ok: true, sub: String(req.headers['x-test-sub'] ?? '') }),
      resolveServer: ({ sub }) => (servers[sub] ? { server: servers[sub] } : null),
    });
    await host.start();
    hosts.push(host);
    const port = host.address()!.port;

    const call = async (sub: string) => {
      await request(port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT, 'x-test-sub': sub }, body: initBody });
      const res = await request(port, 'POST', '/mcp', {
        headers: { accept: MCP_ACCEPT, 'x-test-sub': sub },
        body: { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'marker', arguments: {} } },
      });
      return { status: res.status, text: res.text };
    };

    const a = await call('tenant-a');
    const b = await call('tenant-b');
    expect(a.status).toBe(200);
    expect(JSON.parse(a.text).result.content[0].text).toBe('A');
    expect(JSON.parse(b.text).result.content[0].text).toBe('B');

    // an unknown subject resolves no server: 403 tenant_not_found, never the boot server
    const unknown = await request(port, 'POST', '/mcp', {
      headers: { accept: MCP_ACCEPT, 'x-test-sub': 'tenant-zz' },
      body: initBody,
    });
    expect(unknown.status).toBe(403);
    expect(JSON.parse(unknown.text).error).toBe('tenant_not_found');
  });

  it('two subjects resolving to ONE server share its lane and never overlap on it', async () => {
    let active = 0;
    let peak = 0;
    const shared = new McpServer({ name: 'shared', version: '0.0.0' });
    shared.registerTool('work', { description: 'do work', inputSchema: z.object({}) }, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 150));
      active--;
      return { content: [{ type: 'text' as const, text: 'done' }] };
    });
    const config = { ...resolveHttpConfig({ MCP_TRANSPORT: 'http' }), port: 0 };
    const host = new HttpTransportHost({
      server: makeServer(),
      config,
      version: '9.9.9',
      ownerConfigured: true,
      authenticate: (req) => ({ ok: true, sub: String(req.headers['x-test-sub'] ?? '') }),
      resolveServer: () => ({ server: shared }),
    });
    await host.start();
    hosts.push(host);
    const port = host.address()!.port;
    const work = (sub: string) =>
      request(port, 'POST', '/mcp', {
        headers: { accept: MCP_ACCEPT, 'x-test-sub': sub },
        body: { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'work', arguments: {} } },
      });
    const results = await Promise.all([work('sub-1'), work('sub-2')]);
    expect(results.map((r) => JSON.parse(r.text).result.content[0].text)).toEqual(['done', 'done']);
    expect(peak).toBe(1);
  });

  it('an idle subject lane leaves the lock map', async () => {
    const servers: Record<string, McpServer> = { 'tenant-a': makeServer(), 'tenant-b': makeServer() };
    const config = { ...resolveHttpConfig({ MCP_TRANSPORT: 'http' }), port: 0 };
    const host = new HttpTransportHost({
      server: makeServer(),
      config,
      version: '9.9.9',
      ownerConfigured: true,
      authenticate: (req) => ({ ok: true, sub: String(req.headers['x-test-sub'] ?? '') }),
      resolveServer: ({ sub }) => (servers[sub] ? { server: servers[sub] } : null),
    });
    await host.start();
    hosts.push(host);
    const port = host.address()!.port;
    await Promise.all(
      ['tenant-a', 'tenant-b', 'tenant-a'].map((sub) =>
        request(port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT, 'x-test-sub': sub }, body: initBody }),
      ),
    );
    await new Promise((r) => setImmediate(r));
    expect((host as unknown as { locks: Map<unknown, unknown> }).locks.size).toBe(0);
  });

  it('a resolved target carries its own request hooks; the host-level ones never serve another subject', async () => {
    const named = () => {
      const s = new McpServer({ name: 'srv', version: '0.0.0' });
      s.registerTool('count', { description: 'takes a number', inputSchema: z.object({ n: z.number() }) }, async () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
      }));
      return s;
    };
    const hooks = (defaultAccount: string) => ({
      argShapeFor: vi.fn(() => undefined),
      validationEnvelope: { isKnownTool: () => true, defaultAccount: () => defaultAccount },
    });
    const a = hooks('a-default');
    const b = hooks('b-default');
    const boot = hooks('boot-default');
    const servers: Record<string, McpServer> = { 'tenant-a': named(), 'tenant-b': named() };
    const targets: Record<string, typeof a> = { 'tenant-a': a, 'tenant-b': b };
    const config = { ...resolveHttpConfig({ MCP_TRANSPORT: 'http' }), port: 0 };
    const host = new HttpTransportHost({
      server: makeServer(),
      config,
      version: '9.9.9',
      ownerConfigured: true,
      authenticate: (req) => ({ ok: true, sub: String(req.headers['x-test-sub'] ?? '') }),
      argShapeFor: boot.argShapeFor,
      validationEnvelope: boot.validationEnvelope,
      resolveServer: ({ sub }) => (servers[sub] ? { server: servers[sub], ...targets[sub] } : null),
    });
    await host.start();
    hosts.push(host);
    const port = host.address()!.port;

    const invalidCall = async (sub: string) => {
      await request(port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT, 'x-test-sub': sub }, body: initBody });
      const res = await request(port, 'POST', '/mcp', {
        headers: { accept: MCP_ACCEPT, 'x-test-sub': sub },
        body: { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'count', arguments: { n: 'x' } } },
      });
      return JSON.parse(JSON.parse(res.text).result.content[0].text) as { error: string; account: string };
    };

    const envA = await invalidCall('tenant-a');
    const envB = await invalidCall('tenant-b');
    expect(envA.error).toBe('validation_error');
    expect(envA.account).toBe('a-default');
    expect(envB.account).toBe('b-default');
    expect(a.argShapeFor).toHaveBeenCalledWith('count');
    expect(b.argShapeFor).toHaveBeenCalledWith('count');
    expect(boot.argShapeFor).not.toHaveBeenCalled();
  });

  it('per-subject lock lanes are independent: one tenant\'s slow call never queues another\'s (S1.15)', async () => {
    const named = (marker: string, delayMs: number) => {
      const s = new McpServer({ name: `srv-${marker}`, version: '0.0.0' });
      s.registerTool('work', { description: 'do work', inputSchema: z.object({}) }, async () => {
        await new Promise((r) => setTimeout(r, delayMs));
        return { content: [{ type: 'text' as const, text: marker }] };
      });
      return s;
    };
    const servers: Record<string, McpServer> = { slow: named('SLOW', 700), fast: named('FAST', 0) };
    const config = { ...resolveHttpConfig({ MCP_TRANSPORT: 'http' }), port: 0 };
    const host = new HttpTransportHost({
      server: makeServer(),
      config,
      version: '9.9.9',
      ownerConfigured: true,
      authenticate: (req) => ({ ok: true, sub: String(req.headers['x-test-sub'] ?? '') }),
      resolveServer: ({ sub }) => (servers[sub] ? { server: servers[sub] } : null),
    });
    await host.start();
    hosts.push(host);
    const port = host.address()!.port;

    for (const sub of ['slow', 'fast']) {
      await request(port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT, 'x-test-sub': sub }, body: initBody });
    }
    const callWork = (sub: string) =>
      request(port, 'POST', '/mcp', {
        headers: { accept: MCP_ACCEPT, 'x-test-sub': sub },
        body: { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'work', arguments: {} } },
      }).then((r) => ({ sub, r }));

    const slowP = callWork('slow');
    const fastP = callWork('fast');
    const first = await Promise.race([slowP, fastP]);
    // under the old single global lock, fast would queue behind slow
    expect(first.sub).toBe('fast');
    const [slow] = await Promise.all([slowP]);
    expect(JSON.parse(slow.r.text).result.content[0].text).toBe('SLOW');
  });

  it('GET /mcp is 405 (no SSE in stateless mode)', async () => {
    const port = await startHost();
    const res = await request(port, 'GET', '/mcp');
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('POST');
  });

  it('GET /health returns status + no secrets', async () => {
    const port = await startHost();
    const res = await request(port, 'GET', '/health');
    expect(res.status).toBe(200);
    const json = JSON.parse(res.text);
    expect(json).toMatchObject({ status: 'ok', transport: 'http', ownerConfigured: true });
    expect(res.text).not.toMatch(/MASTER_KEY|token|secret|@/i);
  });

  it('rejects a present-but-invalid Origin with 403', async () => {
    const port = await startHost();
    const res = await request(port, 'POST', '/mcp', {
      headers: { accept: MCP_ACCEPT, origin: 'https://evil.example' },
      body: initBody,
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.text).error).toBe('origin_rejected');
  });

  it('rejects a bad Host with 403', async () => {
    const port = await startHost();
    const res = await request(port, 'POST', '/mcp', {
      headers: { accept: MCP_ACCEPT, host: 'evil.example' },
      body: initBody,
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.text).error).toBe('host_rejected');
  });

  it('rejects unauthenticated callers (401 from the authenticator)', async () => {
    const port = await startHost(() => ({ ok: false, status: 401, body: JSON.stringify({ error: 'unauthorized' }) }));
    const res = await request(port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: initBody });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.text).error).toBe('unauthorized');
  });

  it('unknown path is 404', async () => {
    const port = await startHost();
    const res = await request(port, 'GET', '/nope');
    expect(res.status).toBe(404);
  });

  it('handles many concurrent /mcp requests without "Already connected" 500s', async () => {
    const port = await startHost();
    await request(port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: initBody });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(port, 'POST', '/mcp', {
          headers: { accept: MCP_ACCEPT },
          body: { jsonrpc: '2.0', id: 100 + i, method: 'tools/list', params: {} },
        }),
      ),
    );
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(JSON.parse(r.text).result.tools).toBeDefined();
    }
  });

  it('recovers after a client disconnects mid-dispatch (mutex not deadlocked)', async () => {
    const port = await startHost();
    await request(port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: initBody });
    // Start a slow (300ms) tool call and abort it ~40ms in.
    const ac = new AbortController();
    const slow = request(port, 'POST', '/mcp', {
      headers: { accept: MCP_ACCEPT },
      body: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'slow', arguments: {} } },
      signal: ac.signal,
    }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 40));
    ac.abort();
    await slow;
    // If the lock wedged on disconnect this would hang; it must return promptly.
    const after = await request(port, 'POST', '/mcp', {
      headers: { accept: MCP_ACCEPT },
      body: { jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} },
    });
    expect(after.status).toBe(200);
    expect(JSON.parse(after.text).result.tools).toBeDefined();
  });

  it('releases the lock when a handler exceeds the dispatch deadline (504, not wedged)', async () => {
    const port = await startHost(() => ({ ok: true }), { dispatchTimeoutMs: 80 });
    await request(port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: initBody });
    // A handler that hangs while the client keeps the connection open — this is
    // the case the res-'close' race does NOT cover.
    const hung = await request(port, 'POST', '/mcp', {
      headers: { accept: MCP_ACCEPT },
      body: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'hang', arguments: {} } },
    });
    expect(hung.status).toBe(504);
    // The global lock must have released — a subsequent request returns promptly.
    const after = await request(port, 'POST', '/mcp', {
      headers: { accept: MCP_ACCEPT },
      body: { jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} },
    });
    expect(after.status).toBe(200);
    expect(JSON.parse(after.text).result.tools).toBeDefined();
  });

  it('logs a concise success line on a completed dispatch (method only, no PII)', async () => {
    const logs: string[] = [];
    const port = await startHost(() => ({ ok: true }), { log: (l) => logs.push(l) });
    await request(port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: initBody });
    await request(port, 'POST', '/mcp', {
      headers: { accept: MCP_ACCEPT },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    });
    expect(logs).toContain('200 /mcp method=initialize');
    expect(logs).toContain('200 /mcp method=tools/list');
    // no params / arguments / secrets leak into the log
    expect(logs.join('\n')).not.toMatch(/params|arguments|protocolVersion/);
  });

  it('a route that throws answers a generic 500 and logs the real message with the path, never the query', async () => {
    const logs: string[] = [];
    const port = await startHost(() => ({ ok: true }), {
      log: (l) => logs.push(l),
      routes: {
        '/token': async () => {
          throw new Error('Timed out waiting for lock /srv/state/mcp-tokens.enc.lock');
        },
        '/odd': async () => {
          throw 'not an Error';
        },
      },
    });
    const res = await request(port, 'POST', '/token?code=query-secret');
    expect(res.status).toBe(500);
    expect(JSON.parse(res.text)).toEqual({ error: 'internal_error', message: 'internal error' });
    expect(res.text).not.toMatch(/srv|lock/);
    const odd = await request(port, 'GET', '/odd');
    expect(JSON.parse(odd.text)).toEqual({ error: 'internal_error', message: 'internal error' });
    const bad = await request(port, 'GET', '//');
    expect(bad.status).toBe(500);
    expect(JSON.parse(bad.text)).toEqual({ error: 'internal_error', message: 'internal error' });
    expect(logs).toEqual([
      expect.stringMatching(/^listening on /),
      '500 internal_error path=/token: Timed out waiting for lock /srv/state/mcp-tokens.enc.lock',
      '500 internal_error path=/odd: non-Error throw',
      '500 internal_error path=?: Invalid URL',
    ]);
  });

  it('a host log that throws on the 500 line leaves the answered connection open', async () => {
    const port = await startHost(() => ({ ok: true }), {
      log: (l) => {
        if (l.startsWith('500')) throw new Error('log sink down');
      },
      routes: {
        '/boom': async () => {
          throw new Error('route failed');
        },
      },
    });
    const conn = wire(port);
    const ask = 'GET /boom HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n';
    conn.socket.write(ask);
    await until(() => responsesOf(conn.received()).length === 1, 'the first answer');
    conn.socket.write(ask);
    await until(() => responsesOf(conn.received()).length === 2, 'the second answer on the same connection');
    for (const r of responsesOf(conn.received())) {
      expect(r.head).toMatch(/^HTTP\/1\.1 500 /);
      expect(JSON.parse(r.body)).toEqual({ error: 'internal_error', message: 'internal error' });
    }
    expect(conn.socket.destroyed).toBe(false);
    conn.socket.destroy();
  });
});

async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const tick = () => new Promise((r) => setImmediate(r));
const callTool = (id: number, name: string) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });

/** One /mcp POST as raw bytes, so a test can pipeline several on one socket. */
function rawPost(frame: unknown, headers: Record<string, string> = {}): string {
  const body = JSON.stringify(frame);
  const head = { host: '127.0.0.1', accept: MCP_ACCEPT, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...headers };
  return `POST /mcp HTTP/1.1\r\n${Object.entries(head).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n${body}`;
}

function rawSocket(port: number): net.Socket {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => undefined);
  return socket;
}

/** Two servers behind one host: sub `a` reaches A (whose `held` tool waits
 * for the test to open its gate), sub `b` reaches B. */
async function laneHost(extra: Partial<HttpHostOptions> = {}) {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const held = { calls: 0 };
  const make = (name: string) => {
    const s = new McpServer({ name, version: '0.0.0' });
    s.registerTool('ping', { description: 'ping', inputSchema: z.object({}) }, async () => ({
      content: [{ type: 'text' as const, text: 'pong' }],
    }));
    s.registerTool('held', { description: 'waits for the gate', inputSchema: z.object({}) }, async () => {
      held.calls++;
      await gate;
      return { content: [{ type: 'text' as const, text: 'released' }] };
    });
    return s;
  };
  const servers: Record<string, McpServer> = { a: make('A'), b: make('B') };
  const resolved: string[] = [];
  const logs: string[] = [];
  const config = { ...resolveHttpConfig({ MCP_TRANSPORT: 'http' }), port: 0 };
  const host = new HttpTransportHost({
    server: makeServer(),
    config,
    version: '9.9.9',
    ownerConfigured: true,
    authenticate: (req) => ({ ok: true, sub: String(req.headers['x-test-sub'] ?? '') }),
    resolveServer: ({ sub }) => {
      resolved.push(sub);
      return servers[sub] ? { server: servers[sub] } : null;
    },
    log: (l) => logs.push(l),
    ...extra,
  });
  await host.start();
  hosts.push(host);
  const port = host.address()!.port;
  const call = (sub: string, tool: string, signal?: AbortSignal) =>
    request(port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT, 'x-test-sub': sub }, body: callTool(1, tool), signal });
  const admitted = async (sub: string, n: number) => {
    await until(() => resolved.filter((s) => s === sub).length >= n, `${n} resolutions of ${sub}`);
    await tick();
  };
  return { host, port, open, held, logs, call, admitted };
}

describe('HttpTransportHost lane bounds', () => {
  it('maxQueuedPerLane: a full lane answers 429 lane_busy while another server still completes', async () => {
    const h = await laneHost({ maxQueuedPerLane: 2 });
    const first = h.call('a', 'held');
    const second = h.call('a', 'held');
    await h.admitted('a', 2);
    const third = await h.call('a', 'ping');
    expect(third.status).toBe(429);
    expect(third.headers['retry-after']).toBe('1');
    expect(JSON.parse(third.text)).toEqual({ error: 'lane_busy', message: 'too many requests are already queued for this server' });
    expect(h.logs).toContain('429 lane_busy path=/mcp');
    const other = await h.call('b', 'ping');
    expect(other.status).toBe(200);
    expect(JSON.parse(other.text).result.content[0].text).toBe('pong');
    h.open();
    for (const r of await Promise.all([first, second])) expect(JSON.parse(r.text).result.content[0].text).toBe('released');
  });

  it('the lane slot is released on every exit', async () => {
    const ping = (port: number) => request(port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: callTool(1, 'ping') });
    const bodies = await startHost(undefined, { maxQueuedPerLane: 1, maxBodyBytes: 200 });
    await request(bodies, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, raw: 'x'.repeat(400) }).catch(() => undefined);
    expect((await ping(bodies)).status).toBe(200);
    const bad = await request(bodies, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, raw: '{not json' });
    expect(JSON.parse(bad.text).error).toBe('invalid_body');
    expect((await ping(bodies)).status).toBe(200);
    const batch = await request(bodies, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, raw: JSON.stringify(Array.from({ length: 17 }, () => ({}))) });
    expect(JSON.parse(batch.text).error).toBe('batch_too_large');
    expect((await ping(bodies)).status).toBe(200);

    const runs = await startHost(undefined, { maxQueuedPerLane: 1, dispatchTimeoutMs: 80 });
    const hung = await request(runs, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: callTool(2, 'hang') });
    expect(hung.status).toBe(504);
    expect((await ping(runs)).status).toBe(200);
    const ac = new AbortController();
    const left = request(runs, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: callTool(3, 'slow'), signal: ac.signal }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await left;
    await until(async () => (await ping(runs)).status === 200, 'the slot of a client that left mid-dispatch');
  });

  it('a client that leaves before its body is read releases its slot', async () => {
    let calls = 0;
    const config = { ...resolveHttpConfig({ MCP_TRANSPORT: 'http' }), port: 0 };
    const server = makeServer();
    const host = new HttpTransportHost({
      server: makeServer(),
      config,
      version: '9.9.9',
      ownerConfigured: true,
      authenticate: () => ({ ok: true }),
      maxQueuedPerLane: 1,
      resolveServer: async () => {
        if (calls++ === 0) await new Promise((r) => setTimeout(r, 100));
        return { server };
      },
    });
    await host.start();
    hosts.push(host);
    const port = host.address()!.port;
    const ac = new AbortController();
    const left = request(port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: callTool(1, 'ping'), signal: ac.signal }).catch(() => undefined);
    await until(() => calls === 1, 'the first resolution');
    ac.abort();
    await left;
    await new Promise((r) => setTimeout(r, 150));
    const after = await request(port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: callTool(2, 'ping') });
    expect(after.status).toBe(200);
  });

  it.each([undefined, 2])('a request whose client left while queued is never dispatched (maxQueuedPerLane %s)', async (cap) => {
    const h = await laneHost({ maxQueuedPerLane: cap });
    const running = h.call('a', 'held');
    await until(() => h.held.calls === 1, 'the running call');
    const ac = new AbortController();
    const queued = h.call('a', 'held', ac.signal).catch(() => undefined);
    await h.admitted('a', 2);
    ac.abort();
    await queued;
    await new Promise((r) => setTimeout(r, 50));
    h.open();
    expect(JSON.parse((await running).text).result.content[0].text).toBe('released');
    await until(() => h.logs.includes('499 client_gone path=/mcp'), 'the client_gone line');
    expect((await h.call('a', 'ping')).status).toBe(200);
    expect(h.held.calls).toBe(1);
    expect((h.host as unknown as { depth: Map<unknown, unknown> }).depth.size).toBe(0);
  });

  it('a request pipelined behind a held one is never dispatched once its connection is gone', async () => {
    const h = await laneHost();
    const socket = rawSocket(h.port);
    socket.write(rawPost(callTool(1, 'held'), { 'x-test-sub': 'a' }) + rawPost(callTool(2, 'held'), { 'x-test-sub': 'a' }));
    await until(() => h.held.calls === 1, 'the running call');
    await h.admitted('a', 2);
    await new Promise((r) => setTimeout(r, 50));
    socket.destroy();
    await new Promise((r) => setTimeout(r, 50));
    h.open();
    await until(() => h.logs.includes('499 client_gone path=/mcp'), 'the client_gone line');
    expect((await h.call('a', 'ping')).status).toBe(200);
    expect(h.held.calls).toBe(1);
    const books = h.host as unknown as { pending: Map<unknown, unknown>; handling: Set<unknown> };
    await until(() => books.handling.size === 0, 'every handle() to settle');
    expect(books.pending.size).toBe(0);
  });

  it('without maxQueuedPerLane, 20 requests queued on one lane all complete', async () => {
    const port = await startHost();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => request(port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: callTool(i, 'ping') })),
    );
    for (const r of results) expect(JSON.parse(r.text).result.content[0].text).toBe('pong');
  });

  it('maxBatchFrames 1 refuses a 2-frame batch and still dispatches a 1-frame array', async () => {
    const port = await startHost(undefined, { maxBatchFrames: 1 });
    const two = await request(port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: [callTool(1, 'ping'), callTool(2, 'ping')] });
    expect(two.status).toBe(400);
    expect(JSON.parse(two.text)).toEqual({ error: 'batch_too_large', message: 'a JSON-RPC batch may hold at most 1 messages' });
    const one = await request(port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: [callTool(3, 'ping')] });
    expect(one.status).toBe(200);
    expect(one.text).toContain('pong');
  });
});

const BIG_CHARS = 8_000_000;

/** One server whose `big` tool answers ~8 MB, well above the loopback socket
 * buffers, and whose `held` tool waits for the test to open its gate. */
async function closeHost(extra: Partial<HttpHostOptions> = {}) {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const held = { calls: 0 };
  const writes = { calls: 0 };
  const server = new McpServer({ name: 'close', version: '0.0.0' });
  server.registerTool('write', { description: 'a call with a side effect', inputSchema: z.object({}) }, async () => {
    writes.calls++;
    return { content: [{ type: 'text' as const, text: 'written' }] };
  });
  server.registerTool('ping', { description: 'ping', inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text' as const, text: 'pong' }],
  }));
  server.registerTool('big', { description: 'a large answer', inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text' as const, text: 'a'.repeat(BIG_CHARS) }],
  }));
  server.registerTool('held', { description: 'waits for the gate', inputSchema: z.object({}) }, async () => {
    held.calls++;
    await gate;
    return { content: [{ type: 'text' as const, text: 'released' }] };
  });
  server.registerTool('heldBig', { description: 'waits for the gate, then answers large', inputSchema: z.object({}) }, async () => {
    held.calls++;
    await gate;
    return { content: [{ type: 'text' as const, text: 'a'.repeat(BIG_CHARS) }] };
  });
  const config = { ...resolveHttpConfig({ MCP_TRANSPORT: 'http' }), port: 0 };
  const host = new HttpTransportHost({ server, config, version: '9.9.9', ownerConfigured: true, authenticate: () => ({ ok: true }), ...extra });
  await host.start();
  hosts.push(host);
  return { host, port: host.address()!.port, open, held, writes };
}

function post(port: number, agent?: http.Agent): { req: http.ClientRequest; response: Promise<http.IncomingMessage> } {
  const req = http.request({
    hostname: '127.0.0.1',
    port,
    method: 'POST',
    path: '/mcp',
    agent,
    headers: { host: '127.0.0.1', accept: MCP_ACCEPT, 'content-type': 'application/json' },
  });
  const response = new Promise<http.IncomingMessage>((resolve, reject) => {
    req.on('response', resolve);
    req.on('error', reject);
  });
  return { req, response };
}

function drain(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    res.on('error', reject);
    res.resume();
  });
}

/** A raw connection that keeps everything the host sends on it. */
function wire(port: number) {
  const socket = rawSocket(port);
  let text = '';
  socket.on('data', (c: Buffer) => (text += c.toString('utf-8')));
  const ended = new Promise<void>((r) => socket.once('close', () => r()));
  return { socket, ended, received: () => text };
}

/** Splits what one connection received into its HTTP/1.1 responses. */
function responsesOf(raw: string): { head: string; body: string }[] {
  const out: { head: string; body: string }[] = [];
  let rest = raw;
  for (;;) {
    const split = rest.indexOf('\r\n\r\n');
    if (split < 0) return out;
    const head = rest.slice(0, split);
    rest = rest.slice(split + 4);
    const length = /^content-length: *(\d+)/im.exec(head);
    let body = '';
    if (length) {
      body = rest.slice(0, Number(length[1]));
      rest = rest.slice(body.length);
    } else {
      for (;;) {
        const line = rest.indexOf('\r\n');
        if (line < 0) break;
        const size = parseInt(rest.slice(0, line), 16);
        rest = rest.slice(line + 2);
        if (!(size > 0)) break;
        body += rest.slice(0, size);
        rest = rest.slice(size + 2);
      }
      rest = rest.slice(2);
    }
    out.push({ head, body });
  }
}

describe('HttpTransportHost graceful close', () => {
  it('close({ graceMs }) stops accepting but lets a multi-megabyte response in flight arrive whole', async () => {
    const h = await closeHost();
    const idle = new http.Agent({ keepAlive: true });
    const busy = new http.Agent({ keepAlive: true });
    try {
      expect((await request(h.port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: callTool(1, 'ping'), agent: idle })).status).toBe(200);
      const { req, response } = post(h.port, busy);
      req.end(JSON.stringify(callTool(2, 'big')));
      const res = await response;
      res.pause();
      // Where loopback buffers absorb the whole body (Windows), the response has
      // already finished on the server side and there is nothing left to wait for.
      const inFlight = (h.host as unknown as { pending: Map<unknown, unknown> }).pending.size > 0;
      let closed = false;
      const closing = h.host.close({ graceMs: 10_000 }).then(() => (closed = true));
      await new Promise((r) => setTimeout(r, 150));
      if (inFlight) expect(closed).toBe(false);
      await expect(request(h.port, 'GET', '/health')).rejects.toThrow();
      const started = Date.now();
      const text = await drain(res);
      expect(res.complete).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(text).result.content[0].text.length).toBe(BIG_CHARS);
      await closing;
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      idle.destroy();
      busy.destroy();
    }
  });

  it('close({ graceMs }) lets a request still reading its body finish, and tells its client the connection closes', async () => {
    const h = await closeHost();
    const agent = new http.Agent({ keepAlive: true });
    try {
      const body = Buffer.from(JSON.stringify(callTool(1, 'ping')));
      const { req, response } = post(h.port, agent);
      req.setHeader('content-length', String(body.length));
      req.write(body.subarray(0, 10));
      await new Promise((r) => setTimeout(r, 50));
      const closing = h.host.close({ graceMs: 10_000 });
      await new Promise((r) => setTimeout(r, 50));
      req.end(body.subarray(10));
      const res = await response;
      const text = await drain(res);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(text).result.content[0].text).toBe('pong');
      expect(res.headers.connection).toBe('close');
      const started = Date.now();
      await closing;
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      agent.destroy();
    }
  });

  it('close({ graceMs }) resolves at once when only idle keep-alive connections remain', async () => {
    const h = await closeHost();
    const agent = new http.Agent({ keepAlive: true });
    try {
      await request(h.port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: callTool(1, 'ping'), agent });
      const started = Date.now();
      await h.host.close({ graceMs: 10_000 });
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      agent.destroy();
    }
  });

  it('close({ graceMs }) waits for a request still being authenticated after its client left', async () => {
    let release!: () => void;
    const authGate = new Promise<void>((r) => (release = r));
    let authCalls = 0;
    const h = await closeHost({
      authenticate: async () => {
        authCalls++;
        await authGate;
        return { ok: true };
      },
    });
    const ac = new AbortController();
    const left = request(h.port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: callTool(1, 'ping'), signal: ac.signal }).catch(() => undefined);
    await until(() => authCalls === 1, 'the authentication');
    ac.abort();
    await left;
    let closed = false;
    const closing = h.host.close({ graceMs: 10_000 }).then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 150));
    expect(closed).toBe(false);
    release();
    await closing;
  });

  it('close({ graceMs }) cuts a request still running when the grace ends', async () => {
    const h = await closeHost();
    const hung = request(h.port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: callTool(1, 'held') }).then(
      () => 'answered',
      () => 'cut',
    );
    await until(() => h.held.calls === 1, 'the running call');
    const started = Date.now();
    await h.host.close({ graceMs: 150 });
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(140);
    expect(took).toBeLessThan(2000);
    expect(await hung).toBe('cut');
    h.open();
  });

  it('close({ graceMs }) answers a call pipelined behind a streaming route response, and ends the connection after it', async () => {
    let openStream!: () => void;
    const streamGate = new Promise<void>((r) => (openStream = r));
    const h = await closeHost({
      routes: {
        '/stream': async (_req, res) => {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.write('first ');
          await streamGate;
          res.end('last');
          return true;
        },
      },
    });
    const conn = wire(h.port);
    conn.socket.write('GET /stream HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n' + rawPost(callTool(2, 'held')));
    await until(() => conn.received().includes('first') && h.held.calls === 1, 'the started response and the running call');
    const closing = h.host.close({ graceMs: 10_000 });
    openStream();
    await until(() => conn.received().includes('last'), 'the end of the started response');
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    h.open();
    await closing;
    await conn.ended;
    expect(Date.now() - started).toBeLessThan(3000);
    const answers = responsesOf(conn.received());
    expect(answers).toHaveLength(2);
    expect(answers[0].body).toBe('first last');
    expect(answers[0].head).not.toMatch(/connection: close/i);
    expect(answers[1].head).toMatch(/connection: close/i);
    expect(JSON.parse(answers[1].body).result.content[0].text).toBe('released');
    expect(h.held.calls).toBe(1);
  });

  it('close({ graceMs }) answers a route pipelined behind an /mcp response that has not started', async () => {
    const h = await closeHost({
      routes: {
        '/small': async (_req, res) => {
          res.end('small');
          return true;
        },
      },
    });
    const conn = wire(h.port);
    conn.socket.write(rawPost(callTool(1, 'held')) + 'GET /small HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n');
    await until(() => h.held.calls === 1, 'the running call');
    await new Promise((r) => setTimeout(r, 50));
    const closing = h.host.close({ graceMs: 10_000 });
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    h.open();
    await closing;
    await conn.ended;
    expect(Date.now() - started).toBeLessThan(3000);
    const answers = responsesOf(conn.received());
    expect(answers).toHaveLength(2);
    expect(JSON.parse(answers[0].body).result.content[0].text).toBe('released');
    expect(answers[1].body).toBe('small');
  });

  it('close({ graceMs }) begun as a small response finishes still delivers a big one pipelined behind it whole', async () => {
    const ref: { host?: HttpTransportHost } = {};
    let closing: Promise<void> | undefined;
    const h = await closeHost({
      routes: {
        '/small': async (_req, res) => {
          res.once('finish', () => (closing = ref.host!.close({ graceMs: 10_000 })));
          res.end('small');
          return true;
        },
      },
    });
    ref.host = h.host;
    const conn = wire(h.port);
    conn.socket.write('GET /small HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n' + rawPost(callTool(2, 'big')));
    await conn.ended;
    await closing;
    const answers = responsesOf(conn.received());
    expect(answers).toHaveLength(2);
    expect(answers[0].body).toBe('small');
    expect(JSON.parse(answers[1].body).result.content[0].text.length).toBe(BIG_CHARS);
  });

  it('close({ graceMs }) still runs a request that was waiting on its lane when the close began', async () => {
    let auths = 0;
    const h = await closeHost({
      authenticate: () => {
        auths++;
        return { ok: true };
      },
    });
    const conn = wire(h.port);
    conn.socket.write(rawPost(callTool(1, 'held')) + rawPost(callTool(2, 'write')));
    await until(() => h.held.calls === 1 && auths === 2, 'the running call and the queued one');
    const closing = h.host.close({ graceMs: 10_000 });
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    h.open();
    await closing;
    await conn.ended;
    expect(Date.now() - started).toBeLessThan(3000);
    const answers = responsesOf(conn.received());
    expect(answers).toHaveLength(2);
    expect(JSON.parse(answers[0].body).result.content[0].text).toBe('released');
    expect(answers[0].head).not.toMatch(/connection: close/i);
    expect(answers[1].head).toMatch(/connection: close/i);
    expect(JSON.parse(answers[1].body).result.content[0].text).toBe('written');
    expect(h.writes.calls).toBe(1);
  });

  it('close({ graceMs }) never handles a request pipelined after the close began, ends its side after the last one before it, and cuts the connection when the grace ends', async () => {
    let auths = 0;
    const h = await closeHost({
      authenticate: () => {
        auths++;
        return { ok: true };
      },
    });
    const conn = wire(h.port);
    conn.socket.write(rawPost(callTool(1, 'held')));
    await until(() => h.held.calls === 1, 'the running call');
    const closing = h.host.close({ graceMs: 1000 });
    await new Promise((r) => setTimeout(r, 50));
    conn.socket.write(rawPost(callTool(2, 'write')));
    await new Promise((r) => setTimeout(r, 50));
    expect(auths).toBe(1);
    const finned = new Promise<number>((r) => conn.socket.once('end', () => r(Date.now())));
    const started = Date.now();
    h.open();
    expect((await finned) - started).toBeLessThan(500);
    await closing;
    await conn.ended;
    expect(Date.now() - started).toBeGreaterThanOrEqual(700);
    expect(h.writes.calls).toBe(0);
    const answers = responsesOf(conn.received());
    expect(answers).toHaveLength(1);
    expect(answers[0].head).toMatch(/connection: close/i);
    expect(JSON.parse(answers[0].body).result.content[0].text).toBe('released');
  });

  it('close({ graceMs }) stops reading a connection once a request arrives after the close, so a pipelined flood never piles up', async () => {
    const h = await closeHost();
    const conn = wire(h.port);
    conn.socket.write(rawPost(callTool(1, 'heldBig')));
    await until(() => h.held.calls === 1, 'the running call');
    let late = 0;
    (h.host as unknown as { httpServer: http.Server }).httpServer.on('request', () => late++);
    const closing = h.host.close({ graceMs: 1500 });
    conn.socket.write('GET /health HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n');
    await until(() => late === 1, 'the first request after the close');
    conn.socket.write('GET /health HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n'.repeat(20_000));
    await new Promise((r) => setTimeout(r, 300));
    expect(late).toBeLessThanOrEqual(2);
    h.open();
    await until(() => {
      try {
        return JSON.parse(responsesOf(conn.received())[0]?.body ?? '') !== undefined;
      } catch {
        return false;
      }
    }, 'the whole answer owed');
    expect(late).toBeLessThanOrEqual(2);
    const answers = responsesOf(conn.received());
    expect(answers[0].head).toMatch(/connection: close/i);
    expect(JSON.parse(answers[0].body).result.content[0].text.length).toBe(BIG_CHARS);
    await closing;
    await conn.ended;
  });

  it('close({ graceMs }) destroys at once a connection whose request headers are still arriving', async () => {
    const h = await closeHost();
    const socket = rawSocket(h.port);
    const ended = new Promise<void>((r) => socket.once('close', () => r()));
    socket.write('POST /mcp HTTP/1.1\r\nhost: 127.0.0.1\r\n');
    await until(() => (h.host as unknown as { sockets: Set<unknown> }).sockets.size === 1, 'the connection');
    const started = Date.now();
    await h.host.close({ graceMs: 10_000 });
    await ended;
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('close() without graceMs during a graceful close still cuts at once', async () => {
    const h = await closeHost();
    const hung = request(h.port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: callTool(1, 'held') }).then(
      () => 'answered',
      () => 'cut',
    );
    await until(() => h.held.calls === 1, 'the running call');
    const graceful = h.host.close({ graceMs: 10_000 });
    const started = Date.now();
    await h.host.close();
    expect(Date.now() - started).toBeLessThan(500);
    expect(await hung).toBe('cut');
    expect(h.host.address()).toBeUndefined();
    h.open();
    await graceful;
  });

  it('close() without graceMs still cuts an in-flight request at once', async () => {
    const h = await closeHost();
    const hung = request(h.port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: callTool(1, 'held') }).then(
      () => 'answered',
      () => 'cut',
    );
    await until(() => h.held.calls === 1, 'the running call');
    const started = Date.now();
    await h.host.close();
    expect(Date.now() - started).toBeLessThan(100);
    expect(await hung).toBe('cut');
    h.open();
  });
  /** A post-close request whose body is far larger than the socket buffers. */
  const lateBody = () => {
    const body = 'x'.repeat(6_000_000);
    return `POST /mcp HTTP/1.1\r\nhost: 127.0.0.1\r\naccept: ${MCP_ACCEPT}\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`;
  };
  /** Reads one chunk every few milliseconds, so the host's last writes wait in
   * its socket buffer when it ends the connection. */
  // Windows ticks timers at about 15.6 ms and reads smaller chunks, so a slow
  // reader there can need several seconds for 8 MB: the graces below leave room.
  const readSlowly = (socket: net.Socket) => {
    socket.pause();
    const every = setInterval(() => {
      socket.once('data', () => socket.pause());
      socket.resume();
    }, 5);
    return () => clearInterval(every);
  };

  it('close({ graceMs }) delivers a started big response whole to a slow reader that pipelines a large body after the close began', async () => {
    const h = await closeHost();
    const conn = wire(h.port);
    conn.socket.write(rawPost(callTool(1, 'big')));
    await until(() => conn.received().length > 0, 'the start of the big response');
    const stop = readSlowly(conn.socket);
    try {
      const closing = h.host.close({ graceMs: 15_000 });
      await new Promise((r) => setTimeout(r, 50));
      conn.socket.write(lateBody());
      await conn.ended;
      await closing;
    } finally {
      stop();
    }
    const answers = responsesOf(conn.received());
    expect(answers).toHaveLength(1);
    expect(JSON.parse(answers[0].body).result.content[0].text.length).toBe(BIG_CHARS);
    expect(h.writes.calls).toBe(0);
  }, 40_000);

  it('close({ graceMs }) delivers a big response not yet started whole to a slow reader that pipelines a large body after the close began', async () => {
    const h = await closeHost();
    const conn = wire(h.port);
    conn.socket.write(rawPost(callTool(1, 'heldBig')));
    await until(() => h.held.calls === 1, 'the running call');
    const stop = readSlowly(conn.socket);
    try {
      const closing = h.host.close({ graceMs: 15_000 });
      await new Promise((r) => setTimeout(r, 50));
      h.open();
      await until(() => conn.received().length > 0, 'the start of the big response');
      conn.socket.write(lateBody());
      await conn.ended;
      await closing;
    } finally {
      stop();
    }
    const answers = responsesOf(conn.received());
    expect(answers).toHaveLength(1);
    expect(answers[0].head).toMatch(/connection: close/i);
    expect(JSON.parse(answers[0].body).result.content[0].text.length).toBe(BIG_CHARS);
  }, 40_000);

  it('a second close({ graceMs }) after the last response finished writing still delivers it whole to a slow reader', async () => {
    const h = await closeHost();
    const conn = wire(h.port);
    conn.socket.write(rawPost(callTool(1, 'heldBig')));
    await until(() => h.held.calls === 1, 'the running call');
    const pending = (h.host as unknown as { pending: Map<unknown, unknown> }).pending;
    let late = 0;
    (h.host as unknown as { httpServer: http.Server }).httpServer.on('request', () => late++);
    const stop = readSlowly(conn.socket);
    try {
      const first = h.host.close({ graceMs: 15_000 });
      conn.socket.write(lateBody());
      await until(() => late === 1, 'the request after the close');
      h.open();
      await until(() => pending.size === 0, 'the last response to finish writing');
      void h.host.close({ graceMs: 15_000 });
      await conn.ended;
      await first;
    } finally {
      stop();
    }
    const answers = responsesOf(conn.received());
    expect(answers).toHaveLength(1);
    expect(JSON.parse(answers[0].body).result.content[0].text.length).toBe(BIG_CHARS);
  }, 40_000);

  it('close({ graceMs }) resolves and fully closes when a route that started its response throws', async () => {
    let fire!: () => void;
    const thrown = new Promise<void>((r) => (fire = r));
    const h = await closeHost({
      routes: {
        '/broken': async (_req, res) => {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.write('partial');
          await thrown;
          throw new Error('route failed mid-response');
        },
      },
    });
    const conn = wire(h.port);
    conn.socket.write('GET /broken HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n');
    await until(() => conn.received().includes('partial'), 'the started response');
    const closing = h.host.close({ graceMs: 20_000 });
    await new Promise((r) => setTimeout(r, 50));
    fire();
    await expect(closing).resolves.toBeUndefined();
    await conn.ended;
    expect(h.host.address()).toBeUndefined();
    expect((h.host as unknown as { closing: boolean }).closing).toBe(false);
  });

  it('a route that throws after starting its response has its connection cut, without an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const h = await closeHost({
        routes: {
          '/broken': async (_req, res) => {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.write('partial');
            await tick();
            throw new Error('route failed mid-response');
          },
        },
      });
      const failSpy = vi.spyOn(h.host as unknown as { fail: () => void }, 'fail');
      const conn = wire(h.port);
      conn.socket.write('GET /broken HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n');
      await conn.ended;
      await new Promise((r) => setTimeout(r, 50));
      expect(conn.received()).toContain('partial');
      expect(failSpy.mock.results.map((r) => r.type)).toEqual(['return']);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('close({ graceMs }) resolves even when answering a failed request itself throws', async () => {
    const logs: string[] = [];
    const h = await closeHost({
      log: (l) => logs.push(l),
      routes: {
        '/broken': async () => {
          throw new Error('route failed');
        },
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    const failSpy = vi.spyOn(h.host as unknown as { fail: () => void }, 'fail').mockImplementation(() => {
      throw new Error('answer failed');
    });
    try {
      const conn = wire(h.port);
      conn.socket.write('GET /broken HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n');
      await until(() => failSpy.mock.calls.length === 1, 'the failed answer');
      await until(() => logs.includes('500 internal_error path=/broken: route failed'), 'the logged cause');
      await h.host.close({ graceMs: 20_000 });
      await conn.ended;
      await new Promise((r) => setTimeout(r, 50));
      expect(h.host.address()).toBeUndefined();
      expect(unhandled).toEqual([]);
    } finally {
      failSpy.mockRestore();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('close({ graceMs }) refuses a grace a timer cannot hold, and leaves the host serving', async () => {
    const h = await closeHost();
    const running = request(h.port, 'POST', '/mcp', { headers: { accept: MCP_ACCEPT }, body: callTool(1, 'held') });
    await until(() => h.held.calls === 1, 'the running call');
    for (const graceMs of [Infinity, 2 ** 31, -1, Number.NaN, '100' as unknown as number]) {
      await expect(h.host.close({ graceMs })).rejects.toThrow(TypeError);
    }
    expect((await request(h.port, 'GET', '/health')).status).toBe(200);
    let closed = false;
    const closing = h.host.close({ graceMs: 2 ** 31 - 1 }).then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 150));
    expect(closed).toBe(false);
    h.open();
    const answer = await running;
    expect(JSON.parse(answer.text).result.content[0].text).toBe('released');
    await closing;
  });
});
