import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveHttpConfig } from '../src/http-config.js';
import {
  HttpTransportHost,
  parseOwnerEmails,
  originAllowed,
  hostAllowed,
  type Authenticator,
} from '../src/http-transport.js';

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

});

// ---- integration: real McpServer over the host (BV-3) ------------------------

const hosts: HttpTransportHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

function makeServer(): McpServer {
  const s = new McpServer({ name: 'test-http', version: '0.0.0' });
  s.registerTool('ping', { description: 'ping the server', inputSchema: {} }, async () => ({
    content: [{ type: 'text' as const, text: 'pong' }],
  }));
  s.registerTool('slow', { description: 'slow tool', inputSchema: {} }, async () => {
    await new Promise((r) => setTimeout(r, 300));
    return { content: [{ type: 'text' as const, text: 'done' }] };
  });
  s.registerTool('hang', { description: 'never settles within a test', inputSchema: {} }, async () => {
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
  extra: { dispatchTimeoutMs?: number } = {},
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
});
