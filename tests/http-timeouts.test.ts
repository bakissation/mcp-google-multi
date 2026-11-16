import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import type { IncomingMessage, Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/server';
import { resolveHttpConfig } from '../src/http-config.js';
import { HttpTransportHost, type HttpHostOptions, type RouteHandler } from '../src/http-transport.js';

const hosts: HttpTransportHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

const drain: RouteHandler = async (req: IncomingMessage, res) => {
  let n = 0;
  for await (const c of req) n += (c as Buffer).length;
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(String(n));
  return true;
};

async function start(extra: Partial<HttpHostOptions>): Promise<{ host: HttpTransportHost; port: number }> {
  const config = { ...resolveHttpConfig({ MCP_TRANSPORT: 'http' }), port: 0 };
  const host = new HttpTransportHost({
    server: new McpServer({ name: 't', version: '0.0.0' }),
    config,
    version: '9.9.9',
    ownerConfigured: true,
    authenticate: () => ({ ok: true }),
    routes: { '/slow': drain, '/limited': drain },
    ...extra,
  });
  await host.start();
  hosts.push(host);
  return { host, port: host.address()!.port };
}

// Sends the head and half the body, waits, then sends the rest.
function slowPost(port: number, path: string, pauseMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let out = '';
    s.on('data', (d) => (out += d.toString()));
    s.on('close', () => resolve(out));
    s.on('error', reject);
    s.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 4\r\nConnection: close\r\n\r\nab`);
    setTimeout(() => s.write('cd'), pauseMs);
  });
}

describe('HTTP server timeouts', () => {
  it('keeps the previous limits when nothing is set', async () => {
    const { host } = await start({});
    const server = (host as unknown as { httpServer: Server }).httpServer;
    expect(server.headersTimeout).toBe(15_000);
    expect(server.requestTimeout).toBe(30_000);
  });

  it('applies the configured limits and never lets the header limit exceed the request limit', async () => {
    const { host } = await start({ headersTimeoutMs: 90_000, requestTimeoutMs: 60_000 });
    const server = (host as unknown as { httpServer: Server }).httpServer;
    expect(server.requestTimeout).toBe(60_000);
    expect(server.headersTimeout).toBe(60_000);
  });

  it('lets one path receive a slow body while the others keep the default limit', async () => {
    const { port } = await start({ requestTimeoutMs: 150, routeRequestTimeoutMs: { '/slow': 0 } });
    const ok = await slowPost(port, '/slow', 400);
    expect(ok).toContain('200 OK');
    expect(ok).toMatch(/\r\n4\r\n/);
    const cut = await slowPost(port, '/limited', 400);
    expect(cut).toContain('408');
    expect(cut).toContain('request_timeout');
  });

  it('applies a longer per-path limit and still cuts a body that exceeds it', async () => {
    const { port } = await start({ requestTimeoutMs: 100, routeRequestTimeoutMs: { '/slow': 300 } });
    expect(await slowPost(port, '/slow', 150)).toContain('200 OK');
    expect(await slowPost(port, '/slow', 700)).toContain('408');
  });
});
