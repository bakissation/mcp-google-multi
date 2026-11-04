import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PROTOCOL_VERSION_META_KEY, CLIENT_INFO_META_KEY, CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server';
import { buildRegistry, createMcpServer, requestHooksFor } from '../src/compose.js';
import { resolveHttpConfig } from '../src/http-config.js';
import { HttpTransportHost } from '../src/http-transport.js';
import { HttpConfirm } from '../src/http-confirm.js';
import { buildIdentityContext, type IdentityContext } from '../src/identity.js';
import { accountSet } from './_tool-harness.js';

// The real registry, the real escape-hatch gate and the real host, with only
// Google itself faked: what an HTTP client actually sees for a gated write.

const hosts: HttpTransportHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

// Only the one Gmail method the tests need; the discovery fetch is stubbed so
// nothing leaves the machine.
const GMAIL_DISCOVERY = {
  baseUrl: 'https://gmail.googleapis.com/',
  resources: {
    users: {
      resources: {
        messages: {
          methods: {
            delete: {
              id: 'gmail.users.messages.delete',
              httpMethod: 'DELETE',
              path: 'gmail/v1/users/{userId}/messages/{id}',
              description: 'Deletes a message.',
              parameters: {
                userId: { location: 'path', required: true, type: 'string' },
                id: { location: 'path', required: true, type: 'string' },
              },
            },
          },
        },
      },
    },
  },
};

const savedEnv = { ...process.env };
beforeEach(() => {
  process.env.DISCOVERY_CACHE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-registry-'));
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => GMAIL_DISCOVERY }));
  delete process.env.GOOGLE_ACCOUNTS;
  process.env.GOOGLE_CLIENT_ID = 'client-id.example.invalid';
  process.env.GOOGLE_CLIENT_SECRET = 'not-a-real-secret';
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...savedEnv };
});

function lane(tokens: boolean, request: ReturnType<typeof vi.fn>, owner = false) {
  // The owner context is the one the account wizard registers for, and only
  // identity.ts can mint it.
  const ctx = owner ? buildIdentityContext(process.env, { transport: 'http' }) : {
    subject: 'alice',
    accounts: accountSet({ test: { email: 'test@example.com' } }, { defaultAccount: 'test' }),
    policy: { profile: 'safe-writes', readOnly: false, allow: [], deny: [], transport: 'http' },
    getClient: vi.fn(async () => ({ request })),
    tokenStore: {
      readToken: vi.fn(() => ({ access_token: 'at', refresh_token: 'rt', scope: 'https://mail.google.com/', token_type: 'Bearer', expiry_date: Date.now() + 3_600_000 })),
      writeToken: vi.fn(),
      updateToken: vi.fn(),
      hasToken: vi.fn(() => true),
    },
  } as unknown as IdentityContext;
  const server = createMcpServer('0.0.0-test');
  const registry = buildRegistry(server, ctx, 'eager');
  registry.httpConfirm = new HttpConfirm({ tokens, env: {} });
  return { server, hooks: requestHooksFor(registry, ctx, null), registry, ctx };
}

async function startHost(tokens: boolean, request: ReturnType<typeof vi.fn>, owner = false): Promise<number> {
  const primary = lane(tokens, request, owner);
  const config = { ...resolveHttpConfig({ MCP_TRANSPORT: 'http' }), port: 0 };
  const host = new HttpTransportHost({
    server: primary.server,
    ...primary.hooks,
    config,
    version: '9.9.9',
    ownerConfigured: true,
    authenticate: () => ({ ok: true, sub: 'alice' }),
    modern: () => {
      const m = lane(tokens, request, owner);
      return { server: m.server, ...m.hooks };
    },
    confirmToken: tokens,
  });
  await host.start();
  hosts.push(host);
  return host.address()!.port;
}

function post(port: number, body: Record<string, any>): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const version = body.params?._meta?.[PROTOCOL_VERSION_META_KEY];
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path: '/mcp',
        headers: {
          host: '127.0.0.1',
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'content-length': String(data.length),
          ...(version ? { 'mcp-protocol-version': version, 'mcp-method': body.method, ...(body.params.name ? { 'mcp-name': body.params.name } : {}) } : {}),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const WRITE = { account: 'test', api: 'gmail', methodId: 'gmail.users.messages.delete', pathParams: { userId: 'me', id: 'msg-1' } };
const legacy = (name: string, args: Record<string, unknown>, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const modern = (name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}, elicit = true) => ({
  jsonrpc: '2.0',
  id: 5,
  method: 'tools/call',
  params: {
    name,
    arguments: args,
    _meta: {
      [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
      [CLIENT_INFO_META_KEY]: { name: 'test-client', version: '1.0.0' },
      [CLIENT_CAPABILITIES_META_KEY]: elicit ? { elicitation: {} } : {},
    },
    ...extra,
  },
});
const payload = (r: { json: any }) => JSON.parse(r.json.result.content[0].text);

describe('a gated write over HTTP (real registry and gate)', () => {
  it('flag off: the 2025 wire refuses exactly as before and nothing reaches Google', async () => {
    const request = vi.fn(async () => ({ data: {}, headers: new Headers(), status: 200 }));
    const port = await startHost(false, request);
    const r = payload(await post(port, legacy('google_api_call', WRITE)));
    expect(r.error).toBe('elicitation_unsupported');
    expect(request).not.toHaveBeenCalled();
  });

  it('flag on: refuse with a token, then send once with the identical call', async () => {
    const request = vi.fn(async () => ({ data: {}, headers: new Headers(), status: 200 }));
    const port = await startHost(true, request);
    const first = payload(await post(port, legacy('google_api_call', WRITE)));
    expect(first.error).toBe('confirmation_required');
    expect(first.summary).toContain('gmail');
    expect(request).not.toHaveBeenCalled();

    const done = await post(port, legacy('google_api_call', { ...WRITE, confirmToken: first.confirmToken }, 2));
    expect(done.json.result.isError).not.toBe(true);
    expect(request).toHaveBeenCalledTimes(1);

    const replay = payload(await post(port, legacy('google_api_call', { ...WRITE, confirmToken: first.confirmToken }, 3)));
    expect(replay.error).toBe('confirmation_invalid');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('a token for one message does not unlock a delete of another', async () => {
    const request = vi.fn(async () => ({ data: {}, headers: new Headers(), status: 200 }));
    const port = await startHost(true, request);
    const first = payload(await post(port, legacy('google_api_call', WRITE)));
    const other = payload(await post(port, legacy('google_api_call', { ...WRITE, pathParams: { userId: 'me', id: 'msg-2' }, confirmToken: first.confirmToken }, 2)));
    expect(other.error).toBe('confirmation_invalid');
    expect(request).not.toHaveBeenCalled();
  });

  it('2026-07-28 wire: input_required, then the accepted retry sends; a decline is write_declined', async () => {
    const request = vi.fn(async () => ({ data: {}, headers: new Headers(), status: 200 }));
    const port = await startHost(false, request);
    const first = (await post(port, modern('google_api_call', WRITE))).json.result;
    expect(first.resultType).toBe('input_required');
    expect(first.inputRequests.confirm.params.message).toContain('gmail');
    expect(request).not.toHaveBeenCalled();

    const declined = await post(port, modern('google_api_call', WRITE, { inputResponses: { confirm: { action: 'decline' } }, requestState: first.requestState }));
    expect(payload(declined).error).toBe('write_declined');
    expect(request).not.toHaveBeenCalled();

    const accepted = await post(port, modern('google_api_call', WRITE, { inputResponses: { confirm: { action: 'accept', content: {} } }, requestState: first.requestState }));
    expect(accepted.json.result.isError).not.toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('subscriptions/listen over HTTP (2026-07-28)', () => {
  const meta = {
    [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
    [CLIENT_INFO_META_KEY]: { name: 'test-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {},
  };
  const listen = { jsonrpc: '2.0', id: 'listen:0', method: 'subscriptions/listen', params: { notifications: { toolsListChanged: true, promptsListChanged: true }, _meta: meta } };
  const toolsList = { jsonrpc: '2.0', id: 7, method: 'tools/list', params: { _meta: meta } };

  it('is answered at once and never holds the lane: tools/list and tools/call still answer', async () => {
    const port = await startHost(false, vi.fn());
    const l = await Promise.race([post(port, listen), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('listen held the request')), 5000))]);
    expect(l.status).toBe(200);
    expect(l.json.id).toBe('listen:0');
    expect(l.json.error.code).toBe(-32601);

    const list = await post(port, toolsList);
    expect(list.json.result.tools.length).toBeGreaterThan(0);
    const call = await post(port, modern('diagnose', {}));
    expect(call.json.result).toBeDefined();
  }, 15000);

  it('repeated listens (client retries) do not queue up behind each other', async () => {
    const port = await startHost(false, vi.fn());
    const all = await Promise.all([post(port, listen), post(port, listen), post(port, toolsList), post(port, listen)]);
    expect(all.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(all[2].json.result.tools.length).toBeGreaterThan(0);
  }, 15000);
});

describe('account_add over HTTP', () => {
  it('with no arguments, names the argument form instead of failing opaquely, on both wires', async () => {
    const request = vi.fn();
    const port = await startHost(false, request, true);
    const a = payload(await post(port, legacy('account_add', {})));
    expect(a.error).toBe('elicitation_unsupported');
    expect(a.hint).toContain('"alias"');
    const b = payload(await post(port, modern('account_add', {}, {}, false)));
    expect(b.error).toBe('elicitation_unsupported');
    expect(b.hint).toContain('"alias"');
  });
});
