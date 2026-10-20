import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolRegistry, inferCud } from '../src/registry.js';
import { nearestMethodIds, registerEscapeTools, escapeHatchNames } from '../src/tools/google-api.js';
import { clearDiscoveryMemoryCache, searchMethods } from '../src/discovery-client.js';
import { setHintProvider, type HintCase } from '../src/hint-provider.js';
import { isAllowed, isAllowedByAnyName, type Policy } from '../src/write-control.js';
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
            send: {
              id: 'gmail.users.messages.send',
              httpMethod: 'POST',
              path: 'gmail/v1/users/{userId}/messages/send',
              description: 'Sends a message.',
              parameters: { userId: { location: 'path', required: true, type: 'string' } },
            },
            trash: {
              id: 'gmail.users.messages.trash',
              httpMethod: 'POST',
              path: 'gmail/v1/users/{userId}/messages/{id}/trash',
              description: 'Moves a message to Trash.',
              parameters: {
                userId: { location: 'path', required: true, type: 'string' },
                id: { location: 'path', required: true, type: 'string' },
              },
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
          methods: {
            updateVacation: {
              id: 'gmail.users.settings.updateVacation',
              httpMethod: 'PUT',
              path: 'gmail/v1/users/{userId}/settings/vacation',
              description: 'Updates vacation responder settings.',
              parameters: { userId: { location: 'path', required: true, type: 'string' } },
            },
          },
        },
      },
    },
  },
};

const CALENDAR_FIXTURE = {
  baseUrl: 'https://www.googleapis.com/',
  resources: {
    events: {
      methods: {
        delete: {
          id: 'calendar.events.delete',
          httpMethod: 'DELETE',
          path: 'calendar/v3/calendars/{calendarId}/events/{eventId}',
          description: 'Deletes an event.',
          parameters: {
            calendarId: { location: 'path', required: true, type: 'string' },
            eventId: { location: 'path', required: true, type: 'string' },
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
    files: {
      methods: {
        update: {
          id: 'drive.files.update',
          httpMethod: 'PATCH',
          path: 'drive/v3/files/{fileId}',
          description: 'Updates a file (move, rename, trash, replace content).',
          parameters: { fileId: { location: 'path', required: true, type: 'string' } },
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
        createContact: {
          id: 'people.people.createContact',
          httpMethod: 'POST',
          path: 'v1/people:createContact',
          description: 'Creates a contact.',
          parameters: {},
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
        : url.includes('/calendar/') ? CALENDAR_FIXTURE
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

  // M2: deny on the explicit example from the review ("gmail:set_vacation",
  // "drive:move", "calendar:delete_event", "contacts:create") blocks the
  // same operation via google_api_call, not just the ids the first version
  // of this map happened to hand-pick.
  describe.each([
    { methodId: 'gmail.users.settings.updateVacation', api: 'gmail', deny: 'gmail:set_vacation', pathParams: { userId: 'me' } },
    { methodId: 'drive.files.update', api: 'drive', deny: 'drive:move', pathParams: { fileId: 'f1' } },
    { methodId: 'calendar.events.delete', api: 'calendar', deny: 'calendar:delete_event', pathParams: { calendarId: 'c1', eventId: 'e1' } },
    { methodId: 'people.people.createContact', api: 'people', deny: 'contacts:create', pathParams: {} },
  ])('reporter example: $deny blocks $methodId via google_api_call', ({ methodId, api, deny, pathParams }) => {
    it('blocked', async () => {
      const policy: Policy = { ...SAFE, deny: [deny] };
      const { call, request, dir } = setup(policy);
      cleanupDirs.push(dir);
      const res = await call({ account: 'test', api, methodId, pathParams, body: {} });
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).error).toBe('write_disabled');
      expect(request).not.toHaveBeenCalled();
    });
  });

  // LOW (allow semantics): deny on any candidate name wins, ALLOW on any
  // candidate name must also win (over the profile); the previous
  // implementation treated "every name must pass" as if allow needed
  // unanimous consent too, so an explicit GOOGLE_WRITE_ALLOW stopped
  // working through the escape hatch the moment the full-path or
  // last-segment synthetic name did not separately match the same glob.
  it('GOOGLE_WRITE_ALLOW="gmail:send" grants gmail.users.messages.send via the escape hatch under read-only', async () => {
    const policy: Policy = { profile: 'read-only', readOnly: false, allow: ['gmail:send'], deny: [] };
    const { call, request, dir } = setup(policy);
    cleanupDirs.push(dir);
    const res = await call({ account: 'test', api: 'gmail', methodId: 'gmail.users.messages.send', pathParams: { userId: 'me' }, body: { raw: 'x' } });
    expect(res.isError).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  // LOW (allow semantics): the profile's own exceptions (TRASH_MOVE_TOOLS)
  // are keyed to the REAL tool name. gmail.users.messages.trash's curated
  // name is gmail_trash (in TRASH_MOVE_TOOLS), but its full-path synthetic
  // name gmail_users_messages_trash is not; safe-writes must decide on the
  // real name, not refuse because a synthetic name does not carry the
  // exception.
  it('safe-writes allows gmail.users.messages.trash via the escape hatch like curated gmail_trash', async () => {
    const { call, request, dir } = setup(SAFE);
    cleanupDirs.push(dir);
    const res = await call({ account: 'test', api: 'gmail', methodId: 'gmail.users.messages.trash', pathParams: { userId: 'me', id: 'm1' } });
    expect(res.isError).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  // M2 sweep: EVERY method id this server knows a real tool name for (the
  // full CURATED_METHOD_TOOLS map derived from the curated registrations
  // themselves (not a hand-picked sample), plus every GENERATED_METHOD_TOOLS
  // entry) gives the same write-control verdict through isAllowed directly
  // (as the named tool would see) and through the escape hatch's
  // candidate-name resolution, under both a matching deny and a matching
  // allow. inferCud(name) stands in for the method's real cud throughout
  // (both sides of each comparison use it), so this isolates the NAME
  // resolution this fix is about from cud computation, which is covered
  // elsewhere.
  describe('M2: parity sweep over every curated and generated method id', () => {
    function serviceOf(toolName: string): string {
      const i = toolName.indexOf('_');
      return i === -1 ? toolName : toolName.slice(0, i);
    }
    function opOf(toolName: string): string {
      const i = toolName.indexOf('_');
      return i === -1 ? toolName : toolName.slice(i + 1);
    }

    const curatedEntries = Object.entries(CURATED_METHOD_TOOLS).flatMap(([methodId, names]) =>
      names.map((toolName) => ({ methodId, toolName })),
    );
    const generatedEntries = Object.entries(GENERATED_METHOD_TOOLS).map(([methodId, toolName]) => ({ methodId, toolName }));
    const allEntries = [...curatedEntries, ...generatedEntries];
    const writeEntries = allEntries.filter((e) => inferCud(e.toolName) !== 'read');

    it('sanity: this sweep is not vacuous (hundreds of write entries from both maps)', () => {
      expect(curatedEntries.length).toBeGreaterThan(130);
      expect(generatedEntries.length).toBeGreaterThan(500);
      expect(writeEntries.length).toBeGreaterThan(300);
    });

    // A method several curated tools share (docs/sheets batchUpdate,
    // drive.files.update's move/trash/untrash/transfer/rename) has no
    // single curated identity; "unambiguous" below means either a
    // generated method (always exactly one tool, by construction) or a
    // curated one with exactly one curated tool for it.
    function isUnambiguous(methodId: string): boolean {
      return (CURATED_METHOD_TOOLS[methodId]?.length ?? 0) <= 1;
    }

    it('a deny on the real tool op denies the same call via the escape hatch (every entry, ambiguous or not)', () => {
      for (const { methodId, toolName } of writeEntries) {
        const service = serviceOf(toolName);
        const cud = inferCud(toolName);
        const policy: Policy = { profile: 'full-writes', readOnly: false, allow: [], deny: [`${service}:${opOf(toolName)}`] };
        const direct = isAllowed({ name: toolName, service, cud, scopes: [] }, policy);
        expect(direct, `${methodId} via ${toolName}: the named tool itself should be denied`).toBe(false);
        const names = escapeHatchNames(service, methodId);
        expect(names.deny, `${methodId} via ${toolName}`).toContain(toolName);
        const verdict = isAllowedByAnyName(names.deny, names.allow, { service, cud, scopes: [] }, names.primary, policy);
        expect(verdict.allowed, `${methodId} via ${toolName}: the escape hatch should be denied too`).toBe(false);
      }
    });

    // MEDIUM (item 2): an allow on one narrow curated tool must not open
    // the whole raw method when other curated tools share it (the named
    // tool itself stays grantable either way; only the escape hatch's
    // broader reach is restricted). For an unambiguous entry (one tool,
    // curated or generated) the two still agree, same as before.
    it('an allow on the real tool op always grants the named tool directly', () => {
      for (const { methodId, toolName } of writeEntries) {
        const service = serviceOf(toolName);
        const cud = inferCud(toolName);
        const policy: Policy = { profile: 'read-only', readOnly: false, allow: [`${service}:${opOf(toolName)}`], deny: [] };
        const direct = isAllowed({ name: toolName, service, cud, scopes: [] }, policy);
        expect(direct, `${methodId} via ${toolName}: allow should always grant the named tool`).toBe(true);
      }
    });

    // MEDIUM (item 2), the exact shape of the reported bug: when a raw
    // method is shared by several curated tools, a narrow curated name
    // (e.g. drive_trash) must not, on its own, be eligible to open the
    // whole method through the escape hatch. Deny stays "any name" (the
    // sweep above covers that); allow must drop to the method-wide names
    // only. This is a direct, pure check of escapeHatchNames's output, not
    // of isAllowedByAnyName's glob matching, to avoid conflating two
    // different things under time pressure.
    it('escape-hatch allow excludes a narrow curated name when the method has more than one curated tool', () => {
      let ambiguousChecked = 0;
      for (const [methodId, curatedNames] of Object.entries(CURATED_METHOD_TOOLS)) {
        if (curatedNames.length <= 1) continue;
        const service = serviceOf(curatedNames[0]);
        const names = escapeHatchNames(service, methodId);
        for (const name of curatedNames) {
          expect(names.deny, `${methodId}: deny must still cover ${name}`).toContain(name);
          // A narrow curated name may only appear in allow if it happens to
          // equal a method-wide name already there (docs_batch_update is
          // such a case: it IS the raw-passthrough tool for its method).
          if (names.allow.includes(name)) {
            const methodWideWithoutCurated = names.allow.filter((n) => !curatedNames.includes(n) || n === name);
            expect(methodWideWithoutCurated.length, `${methodId}: ${name} in allow must coincide with a method-wide name`).toBeGreaterThan(0);
          }
        }
        expect(curatedNames.every((n) => names.allow.includes(n)), `${methodId}: allow must not include every shared curated tool (6.0.1 bug)`).toBe(false);
        ambiguousChecked += 1;
      }
      expect(ambiguousChecked).toBeGreaterThan(5);
    });

    it('6.0.1-regression probe: drive:trash, docs:insert_text, calendar:respond_event, drive:create_folder no longer open their whole method via allow', () => {
      const cases: Array<{ methodId: string; op: string; service: string }> = [
        { methodId: 'drive.files.update', op: 'trash', service: 'drive' },
        { methodId: 'docs.documents.batchUpdate', op: 'insert_text', service: 'docs' },
        { methodId: 'calendar.events.patch', op: 'respond_event', service: 'calendar' },
        { methodId: 'drive.files.create', op: 'create_folder', service: 'drive' },
      ];
      for (const { methodId, op, service } of cases) {
        const names = escapeHatchNames(service, methodId);
        const narrowToolName = `${service}_${op}`;
        // None of trash/insert_text/respond_event/create_folder is a CUD
        // value, so unlike e.g. "drive:update" there is no documented
        // service:cud wildcard reading that could legitimately make this
        // allow match anyway; the assertion below is unconditional.
        expect(names.allow, `${methodId}: ${narrowToolName} must not be in the escape hatch's allow set here`).not.toContain(narrowToolName);
        const policy: Policy = { profile: 'read-only', readOnly: false, allow: [`${service}:${op}`], deny: [] };
        const verdict = isAllowedByAnyName(names.deny, names.allow, { service, cud: 'update', scopes: [] }, names.primary, policy);
        // Under 6.0.1 this was allowed=true (the bug); the fix must refuse.
        expect(verdict.allowed, `${methodId} via ${narrowToolName}: escape hatch must refuse (6.0.1 behaviour)`).toBe(false);
      }
    });

    it('with no matching allow or deny, the profile verdict on the primary name matches the named tool (unambiguous entries)', () => {
      for (const policy of [
        { profile: 'read-only', readOnly: false, allow: [], deny: [] } as Policy,
        { profile: 'safe-writes', readOnly: false, allow: [], deny: [] } as Policy,
        { profile: 'full-writes', readOnly: false, allow: [], deny: [] } as Policy,
      ]) {
        for (const { methodId, toolName } of writeEntries) {
          if (!isUnambiguous(methodId)) continue; // no single real identity to compare against; see isUnambiguous
          const service = serviceOf(toolName);
          const cud = inferCud(toolName);
          const direct = isAllowed({ name: toolName, service, cud, scopes: [] }, policy);
          const names = escapeHatchNames(service, methodId);
          const verdict = isAllowedByAnyName(names.deny, names.allow, { service, cud, scopes: [] }, names.primary, policy);
          expect(verdict.allowed, `${methodId} via ${toolName} under profile ${policy.profile}`).toBe(direct);
        }
      }
    });

    it('sanity: the sweep actually contains ambiguous (multi-curated-tool) entries, so the allow test above is not vacuous', () => {
      const ambiguous = writeEntries.filter((e) => !isUnambiguous(e.methodId));
      expect(ambiguous.length).toBeGreaterThan(20);
    });

    // MEDIUM (round 4, M3): lastSegmentName is a GENERIC pattern (service +
    // the method's last dot segment), not derived from any real
    // registration, so it can spell some OTHER method's real curated tool
    // name by pure coincidence (drive.permissions.update's lastSegmentName
    // "drive_update" is ALSO the actual curated tool name for the
    // unrelated drive.files.update). Letting that into allow meant a
    // narrow allow on the real "drive_update" tool widened to grant the
    // escape hatch on every method whose lastSegmentName happens to match
    // it too. Full sweep over the whole curated+generated surface: for
    // every method id, no name in `allow` may be a curated tool's real
    // name unless that curated tool is actually registered for THIS method.
    it('M3: no escape-hatch allow name is a real curated tool name of some OTHER method', () => {
      const curatedAll = new Set(Object.values(CURATED_METHOD_TOOLS).flat());
      const ids = new Set([...Object.keys(CURATED_METHOD_TOOLS), ...Object.keys(GENERATED_METHOD_TOOLS)]);
      const collisions: string[] = [];
      for (const id of ids) {
        const service = id.split('.')[0];
        const names = escapeHatchNames(service, id);
        const own = new Set(CURATED_METHOD_TOOLS[id] ?? []);
        const bad = names.allow.filter((x) => curatedAll.has(x) && !own.has(x));
        if (bad.length > 0) collisions.push(`${id} -> allow also via curated ${bad.join(',')}`);
      }
      expect(collisions, collisions.join('\n')).toEqual([]);
    });

    // Same sweep, the GENERATED-name branch: no escape-hatch allow name
    // may be the generated tool name GENERATED_METHOD_TOOLS assigns to a
    // DIFFERENT method id either (allCuratedNames and allGeneratedNames
    // are two separate collections in the fix; a regression could drop
    // or break either one independently of the other). No such collision
    // actually exists in the current generated surface (gencol.ts-style
    // sweep: 0), so this sweep stays green on its own; it exists to catch
    // one appearing in a future Discovery update.
    it('M3: no escape-hatch allow name is a real generated tool name of some OTHER method', () => {
      const generatedOwner = new Map(Object.entries(GENERATED_METHOD_TOOLS).map(([id, name]) => [name, id]));
      const ids = new Set([...Object.keys(CURATED_METHOD_TOOLS), ...Object.keys(GENERATED_METHOD_TOOLS)]);
      const collisions: string[] = [];
      for (const id of ids) {
        const service = id.split('.')[0];
        const names = escapeHatchNames(service, id);
        for (const name of names.allow) {
          const genOwnerId = generatedOwner.get(name);
          if (genOwnerId && genOwnerId !== id) collisions.push(`${id} -> allow also via generated ${name} (owned by ${genOwnerId})`);
        }
      }
      expect(collisions, collisions.join('\n')).toEqual([]);
    });

    // A clean (non-cud-ambiguous) instance of M3, verified end to end
    // through isAllowedByAnyName, not just the name-level sweep above:
    // "trash" is not a CUD value, so GOOGLE_WRITE_ALLOW="gmail:trash" only
    // ever matched via service:op, never via the service:cud wildcard
    // (unlike e.g. "drive:update", which is unavoidably ambiguous between
    // naming the specific drive_update tool and allowing every update-
    // class drive write by design; docs/configuration.md documents that
    // the latter wins, so those collisions are not re-asserted end to end
    // here). gmail_trash is the curated tool for gmail.users.messages.trash;
    // gmail.users.threads.trash's lastSegmentName happened to spell the
    // same name, so this allow widened to also open the unrelated thread-
    // trash method's escape hatch.
    it('M3: allowing gmail:trash does not also open the unrelated gmail.users.threads.trash via the escape hatch', () => {
      const names = escapeHatchNames('gmail', 'gmail.users.threads.trash');
      const policy: Policy = { profile: 'read-only', readOnly: false, allow: ['gmail:trash'], deny: [] };
      const verdict = isAllowedByAnyName(names.deny, names.allow, { service: 'gmail', cud: 'delete', scopes: [] }, names.primary, policy);
      expect(verdict.allowed).toBe(false);
    });
  });
});
