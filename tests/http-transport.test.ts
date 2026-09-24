import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import { McpServer } from "@modelcontextprotocol/server";
import { resolveHttpConfig } from '../src/http-config.js';
import {
  HttpTransportHost,
  parseOwnerEmails,
  originAllowed,
  hostAllowed,
  jsonRpcMethod,
  type Authenticator,
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
  extra: { dispatchTimeoutMs?: number; log?: (line: string) => void } = {},
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
  opts: { headers?: Record<string, string>; body?: unknown; signal?: AbortSignal } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const data = opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body)) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        signal: opts.signal,
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
});
