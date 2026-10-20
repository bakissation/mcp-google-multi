import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolRegistry } from '../src/registry.js';
import { nearestMethodIds, registerEscapeTools, escapeHatchNames } from '../src/tools/google-api.js';
import { clearDiscoveryMemoryCache, searchMethods } from '../src/discovery-client.js';
import { setHintProvider, type HintCase } from '../src/hint-provider.js';
import { isAllowed, type Policy } from '../src/write-control.js';
import { CURATED_METHOD_TOOLS, GENERATED_METHOD_TOOLS } from '../src/tools/generated/method-map.js';

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
        drafts: {
          methods: {
            send: {
              id: 'gmail.users.drafts.send',
              httpMethod: 'POST',
              path: 'gmail/v1/users/{userId}/drafts/send',
              description: 'Sends an existing draft.',
              parameters: { userId: { location: 'path', required: true, type: 'string' } },
            },
          },
        },
        settings: {
          resources: {
            filters: {
              methods: {
                create: {
                  id: 'gmail.users.settings.filters.create',
                  httpMethod: 'POST',
                  path: 'gmail/v1/users/{userId}/settings/filters',
                  description: 'Creates a filter.',
                  parameters: { userId: { location: 'path', required: true, type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  },
};

// Only the two resources write-control parity cares about: a curated id whose
// real tool name collapses under the old last-segment scheme (permissions
// create/update), and a generated-only id with the same shape (drives.update).
const DRIVE_FIXTURE = {
  baseUrl: 'https://www.googleapis.com/',
  resources: {
    permissions: {
      methods: {
        create: {
          id: 'drive.permissions.create',
          httpMethod: 'POST',
          path: 'drive/v3/files/{fileId}/permissions',
          description: 'Creates a permission for a file.',
          parameters: { fileId: { location: 'path', required: true, type: 'string' } },
        },
        update: {
          id: 'drive.permissions.update',
          httpMethod: 'PATCH',
          path: 'drive/v3/files/{fileId}/permissions/{permissionId}',
          description: 'Updates a permission.',
          parameters: {
            fileId: { location: 'path', required: true, type: 'string' },
            permissionId: { location: 'path', required: true, type: 'string' },
          },
        },
      },
    },
    drives: {
      methods: {
        update: {
          id: 'drive.drives.update',
          httpMethod: 'PUT',
          path: 'drive/v3/drives/{driveId}',
          description: 'Updates a shared drive.',
          parameters: { driveId: { location: 'path', required: true, type: 'string' } },
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

// The searchconsole discovery doc keeps its legacy webmasters.* method ids —
// the fixture mirrors that alias/doc-prefix mismatch.
const SEARCHCONSOLE_FIXTURE = {
  baseUrl: 'https://www.googleapis.com/',
  resources: {
    sites: {
      methods: {
        list: {
          id: 'webmasters.sites.list',
          httpMethod: 'GET',
          path: 'webmasters/v3/sites',
          description: 'Lists sites.',
          parameters: {},
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
      json: async () =>
        url.includes('/people/') ? PEOPLE_FIXTURE
        : url.includes('/slides/') ? POISONED_FIXTURE
        : url.includes('/searchconsole/') ? SEARCHCONSOLE_FIXTURE
        : url.includes('/drive/') ? DRIVE_FIXTURE
        : FIXTURE,
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
  it('advertises google_api_call as a destructive write despite its read cud, and google_api_search as read-only', () => {
    const { registry } = setup(FULL);
    const call = registry.tools.find((t) => t.name === 'google_api_call')!;
    const search = registry.tools.find((t) => t.name === 'google_api_search')!;
    expect(call.cud).toBe('read');
    expect(call.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    expect(search.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

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

  it('fans "analytics" out to both GA4 APIs and reports the resolution', async () => {
    const { search, dir } = setup(FULL);
    cleanupDirs.push(dir);
    const res = await search({ query: 'x', api: 'analytics' });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text).resolvedApi).toEqual(['analyticsadmin', 'analyticsdata']);
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

  it('drops a caller-supplied empty body on GET reads (undici rejects a GET body)', async () => {
    const { call, request, dir } = setup(READ_ONLY);
    cleanupDirs.push(dir);
    const res = await call({
      account: 'test',
      api: 'gmail',
      methodId: 'gmail.users.messages.list',
      pathParams: { userId: 'me' },
      body: {},
    });
    expect(res.isError).toBeUndefined();
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', data: undefined }));
  });

  it('forwards a real body on write verbs unchanged', async () => {
    const { call, request, dir } = setup(FULL);
    cleanupDirs.push(dir);
    await call({
      account: 'test',
      api: 'gmail',
      methodId: 'gmail.users.messages.batchDelete',
      pathParams: { userId: 'me' },
      body: { ids: ['a', 'b'] },
    });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', data: { ids: ['a', 'b'] } }));
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

  it('requires an explicit toolset for APIs without dedicated named tools', async () => {
    const { call, search, dir } = setup(FULL, { toolsets: new Set(['drive']) });
    cleanupDirs.push(dir);
    const blockedCall = await call({ account: 'test', api: 'slides', methodId: 'slides.nope' });
    expect(JSON.parse(blockedCall.content[0].text).error).toBe('toolset_disabled');
    const blockedSearch = await search({ query: 'presentation', api: 'slides' });
    expect(JSON.parse(blockedSearch.content[0].text).error).toBe('toolset_disabled');

    const explicit = setup(FULL, { toolsets: new Set(['slides']) });
    cleanupDirs.push(explicit.dir);
    const enabled = await explicit.call({ account: 'test', api: 'slides', methodId: 'slides.nope' });
    expect(JSON.parse(enabled.content[0].text).error).toBe('unknown_method');
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

  it('retries an alias-prefixed methodId under the discovery doc prefix (searchconsole -> webmasters)', async () => {
    const { call, request, dir } = setup(FULL);
    cleanupDirs.push(dir);
    const res = await call({ account: 'test', api: 'searchconsole', methodId: 'searchconsole.sites.list' });
    expect(res.isError).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('suggests the closest method ids for an unknown methodId typo', async () => {
    const { call, dir } = setup(FULL);
    cleanupDirs.push(dir);
    const res = await call({ account: 'test', api: 'gmail', methodId: 'gmail.users.messages.lst' });
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.error).toBe('unknown_method');
    expect(payload.hint).toContain('Did you mean');
    expect(payload.hint).toContain('gmail.users.messages.list');
  });

  it('bounds methodId: the schema caps it and the suggestion sweep skips oversized ids', async () => {
    const index = Array.from({ length: 40 }, (_, i) => ({ id: `drive.files.method${i}` })) as never;
    const t0 = performance.now();
    expect(nearestMethodIds('9'.repeat(1_000_000), index)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(250);
    expect(nearestMethodIds('drive.files.method3x', index)).toContain('drive.files.method3');
    // a name at the cap skips the DP for every id whose length alone rules it out
    const wide = Array.from({ length: 1000 }, (_, i) => ({ id: `drive.files.m${i}` })) as never;
    const t1 = performance.now();
    for (let i = 0; i < 200; i++) nearestMethodIds(`${i}`.padStart(128, '9'), wide);
    expect(performance.now() - t1).toBeLessThan(500);

    let schema: Record<string, { safeParse: (v: unknown) => { success: boolean } }> = {};
    const server = {
      registerTool: (name: string, config: { inputSchema: typeof schema }) => {
        if (name === 'google_api_call') schema = config.inputSchema;
        return 'ok';
      },
      sendToolListChanged: vi.fn(),
      server: { setRequestHandler: () => {} },
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'escape-test-'));
    cleanupDirs.push(dir);
    registerEscapeTools(new ToolRegistry(server as never, FULL), FULL, { cacheDir: dir, toolsets: 'all' });
    expect(schema.methodId.safeParse('drive.files.list').success).toBe(true);
    expect(schema.methodId.safeParse('d'.repeat(257)).success).toBe(false);
    expect(schema.api.safeParse('d'.repeat(65)).success).toBe(false);
  });

  it('bounds google_api_search: a caller-sized query scans only a capped keyword set', () => {
    const index = Array.from({ length: 3000 }, (_, i) => ({ id: `api.res.method${i}`, description: 'a '.repeat(200) + `word${i}` })) as never;
    // distinct words: repeating one word collapses to one token and tests nothing
    const t0 = performance.now();
    searchMethods(index, Array.from({ length: 200_000 }, (_, i) => `w${i}`).join(' '));
    expect(performance.now() - t0).toBeLessThan(500);
    // only the first 16 distinct words score
    const words = Array.from({ length: 16 }, (_, i) => `zz${i}`).join(' ');
    expect(searchMethods(index, `${words} method42`, 1)).toEqual([]);
    expect(searchMethods(index, `zz0 method42`, 1).map((m: { id: string }) => m.id)).toEqual(['api.res.method42']);
    // a normal query still ranks by id and description
    expect(searchMethods(index, 'method42 word42', 1).map((m: { id: string }) => m.id)).toEqual(['api.res.method42']);
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

  describe('hint provider routing', () => {
    afterEach(() => setHintProvider(null));

    function echo() {
      const seen: HintCase[] = [];
      setHintProvider({
        render: (c) => {
          seen.push(c);
          return { hint: `kind:${c.kind}`, message: `msg:${c.kind}` };
        },
      });
      return seen;
    }

    it('toolset_disabled renders both message and hint from the provider', async () => {
      const seen = echo();
      const { call, dir } = setup(FULL, { toolsets: new Set(['drive']) });
      cleanupDirs.push(dir);
      const res = await call({ account: 'test', api: 'gmail', methodId: 'gmail.users.messages.list', pathParams: { userId: 'me' } });
      const payload = JSON.parse(res.content[0].text);
      expect(payload.error).toBe('toolset_disabled');
      expect(payload.message).toBe('msg:toolset_disabled');
      expect(payload.hint).toBe('kind:toolset_disabled');
      expect(seen).toEqual([{ kind: 'toolset_disabled', api: 'gmail', service: 'gmail' }]);
    });

    it('untrusted_host renders the hint from the provider', async () => {
      const seen = echo();
      const { call, dir } = setup(FULL);
      cleanupDirs.push(dir);
      const res = await call({ account: 'test', api: 'slides', methodId: 'slides.presentations.get', pathParams: { presentationId: 'p1' } });
      const payload = JSON.parse(res.content[0].text);
      expect(payload.error).toBe('untrusted_host');
      expect(payload.hint).toBe('kind:untrusted_host');
      expect(seen).toEqual([{ kind: 'untrusted_host' }]);
    });
  });
});

// GHSA-8hxf-q445-9cjj / GHSA-9vg8-7mjp-68v5 (part B): write-control on the
// escape hatch collapsed a method id to its last dot-segment, so a
// resource-scoped method (drive.permissions.create, gmail.users.drafts.send,
// gmail.users.settings.filters.create) lost its resource and evaluated as a
// generic drive_create / gmail_send / gmail_create, unmatchable by a
// resource-scoped GOOGLE_WRITE_DENY, and inconsistent with the deny the
// corresponding named tool would have applied.
describe('google_api_call write-control name resolution', () => {
  const SAFE: Policy = { profile: 'safe-writes', readOnly: false, allow: [], deny: [] };

  it('reporter repro: GOOGLE_WRITE_DENY="drive:permissions_*" now blocks drive.permissions.create', async () => {
    const policy: Policy = { ...SAFE, deny: ['drive:permissions_*'] };
    const { call, request, dir } = setup(policy);
    cleanupDirs.push(dir);
    const res = await call({
      account: 'test',
      api: 'drive',
      methodId: 'drive.permissions.create',
      pathParams: { fileId: 'f1' },
      body: { role: 'reader', type: 'anyone' },
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('write_disabled');
    expect(request).not.toHaveBeenCalled();
  });

  it('reporter repro: GOOGLE_WRITE_DENY="gmail:users_settings_*" now blocks gmail.users.settings.filters.create', async () => {
    const policy: Policy = { ...SAFE, deny: ['gmail:users_settings_*'] };
    const { call, request, dir } = setup(policy);
    cleanupDirs.push(dir);
    const res = await call({
      account: 'test',
      api: 'gmail',
      methodId: 'gmail.users.settings.filters.create',
      pathParams: { userId: 'me' },
      body: { action: { forward: 'x@evil.example' } },
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('write_disabled');
    expect(request).not.toHaveBeenCalled();
  });

  it('reporter repro (2B): an op-level deny written against the named tool ("gmail:send_draft") now applies to gmail.users.drafts.send', async () => {
    const policy: Policy = { ...SAFE, deny: ['gmail:send_draft'] };
    const { call, request, dir } = setup(policy);
    cleanupDirs.push(dir);
    const res = await call({ account: 'test', api: 'gmail', methodId: 'gmail.users.drafts.send', pathParams: { userId: 'me' }, body: { id: 'd1' } });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('write_disabled');
    expect(request).not.toHaveBeenCalled();
  });

  it('without a matching deny, the same resource-scoped methods still execute (not a blanket new refusal)', async () => {
    const { call, request, dir } = setup(SAFE);
    cleanupDirs.push(dir);
    const res = await call({
      account: 'test',
      api: 'drive',
      methodId: 'drive.permissions.create',
      pathParams: { fileId: 'f1' },
      body: { role: 'reader', type: 'user', emailAddress: 'a@corp.example' },
    });
    expect(res.isError).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('a coarse pre-fix deny ("drive:create") still blocks the escape hatch (backward compatible)', async () => {
    const policy: Policy = { ...SAFE, deny: ['drive:create'] };
    const { call, request, dir } = setup(policy);
    cleanupDirs.push(dir);
    const res = await call({
      account: 'test',
      api: 'drive',
      methodId: 'drive.permissions.create',
      pathParams: { fileId: 'f1' },
      body: { role: 'reader', type: 'anyone' },
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('write_disabled');
    expect(request).not.toHaveBeenCalled();
  });

  // Parity: for every method id this suite knows a real tool name for (the
  // new curated map, plus a sample of generated ones), an op-level deny
  // pattern written against that real name gives the SAME verdict through
  // isAllowed directly (as the named tool would see) and through the escape
  // hatch's full candidate-name loop.
  describe('parity with the named-tool verdict', () => {
    const cases: Array<{ methodId: string; realName: string; service: string; cud: 'create' | 'update' }> = [
      { methodId: 'drive.permissions.create', realName: 'drive_share', service: 'drive', cud: 'create' },
      { methodId: 'drive.permissions.update', realName: 'drive_permission_update', service: 'drive', cud: 'update' },
      { methodId: 'drive.drives.update', realName: 'drive_drives_update', service: 'drive', cud: 'update' },
      { methodId: 'gmail.users.drafts.send', realName: 'gmail_send_draft', service: 'gmail', cud: 'create' },
      { methodId: 'gmail.users.settings.filters.create', realName: 'gmail_users_settings_filters_create', service: 'gmail', cud: 'create' },
    ];

    it('escapeHatchNames resolves the real tool name for every case', () => {
      for (const c of cases) {
        expect(CURATED_METHOD_TOOLS[c.methodId] ?? GENERATED_METHOD_TOOLS[c.methodId]).toBe(c.realName);
        expect(escapeHatchNames(c.service, c.methodId)).toContain(c.realName);
      }
    });

    it.each(cases)('$methodId: op-level deny on "$realName" denies identically via isAllowed and the escape-hatch loop', (c) => {
      const op = c.realName.slice(c.realName.indexOf('_') + 1);
      for (const deny of [[`${c.service}:${op}`], [`${c.service}:nope`], []]) {
        const policy: Policy = { profile: 'safe-writes', readOnly: false, allow: [], deny };
        const direct = isAllowed({ name: c.realName, service: c.service, cud: c.cud, scopes: [] }, policy);
        const viaEscapeHatch = escapeHatchNames(c.service, c.methodId).every((name) =>
          isAllowed({ name, service: c.service, cud: c.cud, scopes: [] }, policy),
        );
        expect(viaEscapeHatch).toBe(direct);
      }
    });
  });
});
