import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolRegistry } from '../src/registry.js';
import { registerEscapeTools } from '../src/tools/google-api.js';
import { clearDiscoveryMemoryCache } from '../src/discovery-client.js';
import type { Policy } from '../src/write-control.js';

const FIXTURE = {
  baseUrl: 'https://gmail.googleapis.com/',
  resources: {
    users: {
      resources: {
        messages: {
          methods: {
            list: {
              id: 'gmail.users.messages.list',
              httpMethod: 'GET',
              path: 'gmail/v1/users/{userId}/messages',
              description: 'Lists messages.',
              parameters: { userId: { location: 'path', required: true, type: 'string' } },
            },
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
            batchDelete: {
              id: 'gmail.users.messages.batchDelete',
              httpMethod: 'POST',
              path: 'gmail/v1/users/{userId}/messages/batchDelete',
              description: 'Permanently deletes many messages.',
              parameters: { userId: { location: 'path', required: true, type: 'string' } },
            },
          },
        },
      },
    },
  },
};

const POISONED_FIXTURE = {
  baseUrl: 'https://evil.example.com/',
  resources: {
    presentations: {
      methods: {
        get: {
          id: 'slides.presentations.get',
          httpMethod: 'GET',
          path: 'v1/presentations/{presentationId}',
          description: 'Gets a presentation.',
          parameters: { presentationId: { location: 'path', required: true, type: 'string' } },
        },
      },
    },
  },
};

const PEOPLE_FIXTURE = {
  baseUrl: 'https://people.googleapis.com/',
  resources: {
    people: {
      methods: {
        deleteContact: {
          id: 'people.people.deleteContact',
          httpMethod: 'DELETE',
          path: 'v1/{+resourceName}:deleteContact',
          description: 'Deletes a contact.',
          parameters: { resourceName: { location: 'path', required: true, type: 'string' } },
        },
      },
    },
  },
};

function setup(policy: Policy, opts: { toolsets?: 'all' | Set<string> } = {}) {
  const registered: { name: string; handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }> }[] = [];
  const server = {
    registerTool: (name: string, _config: never, handler: never) => {
      registered.push({ name, handler });
      return 'ok';
    },
    sendToolListChanged: vi.fn(),
    server: { setRequestHandler: () => {} },
  };
  const registry = new ToolRegistry(server as never, policy);
  const request = vi.fn(async () => ({ data: { ok: true } }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'escape-test-'));
  registerEscapeTools(registry, policy, {
    cacheDir: dir,
    fetchFn: async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.includes('/people/') ? PEOPLE_FIXTURE : url.includes('/slides/') ? POISONED_FIXTURE : FIXTURE),
    }),
    getClientFn: (async () => ({ request })) as never,
    toolsets: opts.toolsets ?? 'all',
  });
  const call = registered.find((r) => r.name === 'google_api_call')!.handler;
  const search = registered.find((r) => r.name === 'google_api_search')!.handler;
  return { registry, call, search, request, dir };
}

const READ_ONLY: Policy = { profile: 'read-only', readOnly: false, allow: [], deny: [] };
const FULL: Policy = { profile: 'full-writes', readOnly: false, allow: [], deny: [] };

let cleanupDirs: string[] = [];
beforeEach(() => clearDiscoveryMemoryCache());
afterEach(() => {
  clearDiscoveryMemoryCache();
  for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
  cleanupDirs = [];
});

describe('google_api_search', () => {
  it('returns matching methods with cud and invocation hint', async () => {
    const { search, dir } = setup(FULL);
    cleanupDirs.push(dir);
    const res = JSON.parse((await search({ query: 'delete message', api: 'gmail' })).content[0].text);
    const del = res.methods.find((m: { methodId: string }) => m.methodId === 'gmail.users.messages.delete');
    expect(del).toBeDefined();
    expect(del.cud).toBe('delete');
    expect(res.next).toContain('google_api_call');
  });

  it('rejects unknown api aliases', async () => {
    const { search, dir } = setup(FULL);
    cleanupDirs.push(dir);
    const res = await search({ query: 'x', api: 'nope' });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('unknown_api');
  });
});

describe('google_api_call', () => {
  it('dispatches a read method through the OAuth client', async () => {
    const { call, request, dir } = setup(READ_ONLY);
    cleanupDirs.push(dir);
    const res = await call({
      account: 'test',
      api: 'gmail',
      methodId: 'gmail.users.messages.list',
      pathParams: { userId: 'me' },
      queryParams: { q: 'is:unread' },
    });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith({
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages?alt=json&q=is%3Aunread',
      method: 'GET',
      data: undefined,
    });
  });

  it('serializes repeated query params as repeated keys', async () => {
    const { call, request, dir } = setup(FULL);
    cleanupDirs.push(dir);
    await call({
      account: 'test',
      api: 'gmail',
      methodId: 'gmail.users.messages.list',
      pathParams: { userId: 'me' },
      queryParams: { labelIds: ['INBOX', 'UNREAD'], q: 'x' },
    });
    const url = (request.mock.calls[0][0] as { url: string }).url;
    expect(url).toContain('labelIds=INBOX&labelIds=UNREAD');
    expect(url).toContain('alt=json');
    expect(url).toContain('q=x');
  });

  it('enforces write-control on CUD methods', async () => {
    const { call, request, dir } = setup(READ_ONLY);
    cleanupDirs.push(dir);
    const res = await call({
      account: 'test',
      api: 'gmail',
      methodId: 'gmail.users.messages.delete',
      pathParams: { userId: 'me', id: 'abc' },
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('write_disabled');
    expect(request).not.toHaveBeenCalled();
  });

  it('allows CUD methods under full-writes', async () => {
    const { call, request, dir } = setup(FULL);
    cleanupDirs.push(dir);
    const res = await call({
      account: 'test',
      api: 'gmail',
      methodId: 'gmail.users.messages.delete',
      pathParams: { userId: 'me', id: 'abc' },
    });
    expect(res.isError).toBeUndefined();
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'DELETE' }));
  });

  it('blocks POST-based permanent deletes under safe-writes', async () => {
    const SAFE: Policy = { profile: 'safe-writes', readOnly: false, allow: [], deny: [] };
    const { call, request, dir } = setup(SAFE);
    cleanupDirs.push(dir);
    const res = await call({
      account: 'test',
      api: 'gmail',
      methodId: 'gmail.users.messages.batchDelete',
      pathParams: { userId: 'me' },
      body: { ids: ['a'] },
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('write_disabled');
    expect(request).not.toHaveBeenCalled();
  });

  it('matches deny globs against the named-tool service namespace', async () => {
    const DENY_CONTACTS: Policy = { profile: 'full-writes', readOnly: false, allow: [], deny: ['contacts:*'] };
    const { call, request, dir } = setup(DENY_CONTACTS);
    cleanupDirs.push(dir);
    const res = await call({
      account: 'test',
      api: 'people',
      methodId: 'people.people.deleteContact',
      pathParams: { resourceName: 'people/c123' },
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('write_disabled');
    expect(request).not.toHaveBeenCalled();
  });

  it('respects GOOGLE_TOOLSETS for aliases that map to named services', async () => {
    const { call, search, dir } = setup(FULL, { toolsets: new Set(['drive']) });
    cleanupDirs.push(dir);
    const blocked = await call({ account: 'test', api: 'gmail', methodId: 'gmail.users.messages.list', pathParams: { userId: 'me' } });
    expect(JSON.parse(blocked.content[0].text).error).toBe('toolset_disabled');
    const searchBlocked = await search({ query: 'x', api: 'gmail' });
    expect(JSON.parse(searchBlocked.content[0].text).error).toBe('toolset_disabled');
  });

  it('keeps serviceless APIs available regardless of GOOGLE_TOOLSETS', async () => {
    const { call, dir } = setup(FULL, { toolsets: new Set(['drive']) });
    cleanupDirs.push(dir);
    const res = await call({ account: 'test', api: 'slides', methodId: 'slides.nope' });
    expect(JSON.parse(res.content[0].text).error).toBe('unknown_method');
  });

  it('refuses to send credentials to non-googleapis hosts (poisoned cache)', async () => {
    const { call, request, dir } = setup(FULL);
    cleanupDirs.push(dir);
    const res = await call({
      account: 'test',
      api: 'slides',
      methodId: 'slides.presentations.get',
      pathParams: { presentationId: 'p1' },
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('untrusted_host');
    expect(request).not.toHaveBeenCalled();
  });

  it('returns unknown_method with a search hint', async () => {
    const { call, dir } = setup(FULL);
    cleanupDirs.push(dir);
    const res = await call({ account: 'test', api: 'gmail', methodId: 'gmail.nope' });
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.error).toBe('unknown_method');
    expect(payload.hint).toContain('google_api_search');
  });

  it('reports missing path params with the required list', async () => {
    const { call, dir } = setup(FULL);
    cleanupDirs.push(dir);
    const res = await call({ account: 'test', api: 'gmail', methodId: 'gmail.users.messages.list' });
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.error).toBe('invalid_params');
    expect(payload.hint).toContain('userId');
  });
});
