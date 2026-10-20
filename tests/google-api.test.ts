import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolRegistry, inferCud } from '../src/registry.js';
import { nearestMethodIds, registerEscapeTools, escapeHatchNames } from '../src/tools/google-api.js';
import { clearDiscoveryMemoryCache, searchMethods } from '../src/discovery-client.js';
import { setHintProvider, type HintCase } from '../src/hint-provider.js';
import { isAllowed, escapeHatchVerdict, type Policy } from '../src/write-control.js';
import { CURATED_METHOD_TOOLS, GENERATED_METHOD_TOOLS, CUD_OVERRIDES } from '../src/tools/generated/method-map.js';
import { cudFromMethod } from '../src/discovery-client.js';
import { toolHarness, accountSet, type ElicitMode } from './_tool-harness.js';

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
        insert: {
          id: 'calendar.events.insert',
          httpMethod: 'POST',
          path: 'calendar/v3/calendars/{calendarId}/events',
          description: 'Creates an event.',
          parameters: {
            calendarId: { location: 'path', required: true, type: 'string' },
            sendUpdates: { location: 'query', type: 'string' },
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
          parameters: {
            fileId: { location: 'path', required: true, type: 'string' },
            addParents: { location: 'query', type: 'string' },
            removeParents: { location: 'query', type: 'string' },
          },
        },
        copy: {
          id: 'drive.files.copy',
          httpMethod: 'POST',
          path: 'drive/v3/files/{fileId}/copy',
          description: 'Copies a file.',
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

function setup(policy: Policy, opts: { toolsets?: 'all' | Set<string>; elicit?: ElicitMode } = {}) {
  const registered: { name: string; handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }> }[] = [];
  const elicitInput = vi.fn(async (params: { message: string }) => {
    const mode = opts.elicit ?? 'unsupported';
    const action = typeof mode === 'function' ? mode(params.message) : mode;
    if (action === 'unsupported') throw new Error('elicitation not supported by this client (test harness default)');
    if (action === 'throws') throw new Error('simulated: no answer arrived (timeout or dropped connection)');
    if (action === 'unexpected') return { action: 'something_else' };
    return { action };
  });
  // registry.elicitConfirmation checks this BEFORE calling elicitInput; see
  // the matching comment on fakeServer() in tests/_tool-harness.ts.
  const elicitationCapable = (opts.elicit ?? 'unsupported') !== 'unsupported';
  const server = {
    registerTool: (name: string, _config: never, handler: never) => {
      registered.push({ name, handler });
      return 'ok';
    },
    sendToolListChanged: vi.fn(),
    server: {
      setRequestHandler: () => {},
      getClientCapabilities: () => (elicitationCapable ? { elicitation: { form: {} } } : undefined),
      elicitInput,
    },
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
  return { registry, call, search, request, dir, elicitInput };
}

const READ_ONLY: Policy = { profile: 'read-only', readOnly: false, allow: [], deny: [] };
const FULL: Policy = { profile: 'full-writes', readOnly: false, allow: [], deny: [] };

// A real-shaped Gmail raw message (round 7's decodeGmailRaw refuses a
// placeholder like "x" that cannot decode to a real MIME header block).
const SAMPLE_RAW = Buffer.from('To: a@corp.example\r\nSubject: hi\r\n\r\nhello').toString('base64url');

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

  // ROUND 6: under the (default) read-only PROFILE, a write via the escape
  // hatch is no longer an immediate write_disabled; it asks a human (the
  // GOOGLE_READ_ONLY hard flag, not the profile, is what refuses without
  // asking; see the round-6 ask-model describe block below). A client that
  // never declared elicitation support still ends up refused, just via
  // elicitation_unsupported, and fails fast: the capability check in
  // registry.elicitConfirmation means elicitInput is never even attempted.
  it('a CUD method under the default read-only profile asks rather than refusing outright, and still refuses when nothing can answer', async () => {
    const { call, request, dir, elicitInput } = setup(READ_ONLY);
    cleanupDirs.push(dir);
    const res = await call({
      account: 'test',
      api: 'gmail',
      methodId: 'gmail.users.messages.delete',
      pathParams: { userId: 'me', id: 'abc' },
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('elicitation_unsupported');
    expect(elicitInput).not.toHaveBeenCalled();
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

  // ROUND 6: safe-writes through the escape hatch is in the "ask" bucket
  // now, same as every other non-full-writes profile; it is no longer a
  // hard write_disabled on its own (a deny glob still would be, see the
  // name-resolution describe block below). Declining or not being askable
  // still refuses the permanent delete; accepting lets it through.
  it('a permanent delete under safe-writes asks rather than hard-refusing; decline (or no elicitation support) still refuses', async () => {
    const SAFE: Policy = { profile: 'safe-writes', readOnly: false, allow: [], deny: [] };
    const { call, request, dir, elicitInput } = setup(SAFE, { elicit: 'decline' });
    cleanupDirs.push(dir);
    const res = await call({
      account: 'test',
      api: 'gmail',
      methodId: 'gmail.users.messages.batchDelete',
      pathParams: { userId: 'me' },
      body: { ids: ['a'] },
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('write_declined');
    expect(elicitInput).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });

  it('the same permanent delete under safe-writes goes through on accept', async () => {
    const SAFE: Policy = { profile: 'safe-writes', readOnly: false, allow: [], deny: [] };
    const { call, request, dir } = setup(SAFE, { elicit: 'accept' });
    cleanupDirs.push(dir);
    const res = await call({
      account: 'test',
      api: 'gmail',
      methodId: 'gmail.users.messages.batchDelete',
      pathParams: { userId: 'me' },
      body: { ids: ['a'] },
    });
    expect(res.isError).toBeUndefined();
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', data: { ids: ['a'] } }));
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

  // ROUND 6: without a matching deny, this is the ask bucket under
  // safe-writes, not a blanket new refusal; accepting still runs it
  // (the point this test originally made, just via the human confirmation
  // step rather than an outright pass).
  it('without a matching deny, the same resource-scoped method asks and still runs on accept (not a blanket new refusal)', async () => {
    const { call, request, dir, elicitInput } = setup(SAFE, { elicit: 'accept' });
    cleanupDirs.push(dir);
    const res = await call({
      account: 'test',
      api: 'drive',
      methodId: 'drive.permissions.create',
      pathParams: { fileId: 'f1' },
      body: { role: 'reader', type: 'user', emailAddress: 'a@corp.example' },
    });
    expect(res.isError).toBeUndefined();
    expect(elicitInput).toHaveBeenCalledTimes(1);
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

  // ROUND 6: GOOGLE_WRITE_ALLOW no longer opens the escape hatch at all;
  // only full-writes does (deny still wins first, unaffected). An allow
  // glob that would have granted this under 6.0.1 now still triggers the
  // human ask, exactly as a policy with no allow list at all would.
  it('GOOGLE_WRITE_ALLOW="gmail:send" no longer grants gmail.users.messages.send outright; it still asks', async () => {
    const policy: Policy = { profile: 'read-only', readOnly: false, allow: ['gmail:send'], deny: [] };
    const { call, request, dir, elicitInput } = setup(policy, { elicit: 'decline' });
    cleanupDirs.push(dir);
    const res = await call({ account: 'test', api: 'gmail', methodId: 'gmail.users.messages.send', pathParams: { userId: 'me' }, body: { raw: SAMPLE_RAW } });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('write_declined');
    expect(elicitInput).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });

  // ROUND 6: the profile's own exceptions (TRASH_MOVE_TOOLS) only matter to
  // isAllowed(), the curated gate; the escape hatch never consulted it (see
  // escapeHatchVerdict), so safe-writes asks here too, same as any other
  // non-full-writes write through the escape hatch. Accepting lets it
  // through, same end result gmail_trash (curated) still gets unconditionally.
  it('safe-writes asks (not auto-allows) for gmail.users.messages.trash via the escape hatch; accepting runs it', async () => {
    const { call, request, dir } = setup(SAFE, { elicit: 'accept' });
    cleanupDirs.push(dir);
    const res = await call({ account: 'test', api: 'gmail', methodId: 'gmail.users.messages.trash', pathParams: { userId: 'me', id: 'm1' } });
    expect(res.isError).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  // M2 sweep (round 6 shape): escape-hatch DENY-name resolution is
  // unchanged (deny on any candidate name, including the full-path and
  // last-segment synthetic names, still wins before anything else, same
  // as every round-3-to-5 test above). What this sweep no longer checks
  // is an escape-hatch ALLOW side: GOOGLE_WRITE_ALLOW does not touch the
  // escape hatch at all any more (isAllowedByAnyName and
  // escapeHatchNames().allow are both gone), so the M2/M3 collision
  // concerns those used to cover (a narrow curated allow accidentally
  // widening to the whole raw method, or to an unrelated method sharing a
  // synthetic name) no longer apply: there is no allow-side name
  // resolution left to collide.
  describe('M2 (round 6): deny-name parity sweep over every curated and generated method id', () => {
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

    // ROUND 7 (MEDIUM 4): the REAL registry, not a name-text heuristic, is
    // the ground truth for each tool's cud. inferCud(toolName) on both
    // sides of a comparison can never catch a divergence between the two
    // paths' real classification, because both sides would be wrong (or
    // right) together; a generated tool's baked cud (CUD_OVERRIDES-
    // corrected at gen time) is the real one google_api_call must match.
    const ALL_BUNDLES = [
      'slides', 'forms', 'chat', 'analytics', 'analytics_write', 'classroom', 'cloudidentity',
      'cloudsearch', 'vault', 'keep', 'driveactivity', 'drivelabels', 'script', 'postmaster',
      'groupssettings', 'groupsmigration', 'licensing', 'reseller', 'appsmarket',
    ];
    const fullAccounts = accountSet(
      { test: { email: 'test@harness.example', admin: true, scopeProfile: 'full' } },
      { defaultAccount: 'test', scopeProfiles: { full: { bundles: ALL_BUNDLES } } },
    );
    const fullRegistry = toolHarness({ accounts: fullAccounts }).registry;
    // A handful of curated tools (drive_download/drive_export and the like)
    // are owner-only host-file tools and never register for this harness's
    // non-owner context; skipped here as out of scope for a write-class
    // sweep, not silently treated as any particular cud.
    const realCudMap = new Map(fullRegistry.tools.map((t) => [t.name, t.cud] as const));
    function realCud(toolName: string) {
      const cud = realCudMap.get(toolName);
      if (cud === undefined) throw new Error(`tool not in the real registry: ${toolName}`);
      return cud;
    }
    const writeEntries = allEntries.filter((e) => inferCud(e.toolName) !== 'read');
    // Scoped to the one test below that needs real (not name-heuristic)
    // ground truth on both sides; the other sweeps in this block are
    // unaffected and keep using writeEntries/inferCud as before.
    const realWriteEntries = allEntries.filter((e) => realCudMap.has(e.toolName) && realCudMap.get(e.toolName) !== 'read');

    it('sanity: this sweep is not vacuous (hundreds of write entries from both maps)', () => {
      expect(curatedEntries.length).toBeGreaterThan(130);
      expect(generatedEntries.length).toBeGreaterThan(500);
      expect(writeEntries.length).toBeGreaterThan(300);
    });

    it('a deny on the real tool op denies the same call via isAllowed AND via the escape hatch (every entry, ambiguous or not)', () => {
      for (const { methodId, toolName } of realWriteEntries) {
        const service = serviceOf(toolName);
        const cud = realCud(toolName);
        const policy: Policy = { profile: 'full-writes', readOnly: false, allow: [], deny: [`${service}:${opOf(toolName)}`] };
        const direct = isAllowed({ name: toolName, service, cud, scopes: [] }, policy);
        expect(direct, `${methodId} via ${toolName}: the named tool itself should be denied`).toBe(false);
        const names = escapeHatchNames(service, methodId);
        expect(names.deny, `${methodId} via ${toolName}`).toContain(toolName);
        // full-writes would otherwise auto-allow outright; a deny match
        // must still win over that, same requirement as before round 6.
        const verdict = escapeHatchVerdict(names.deny, { service, cud, scopes: [] }, names.primary, policy, false);
        expect(verdict.decision, `${methodId} via ${toolName}: the escape hatch should be denied too`).toBe('deny');
      }
    });

    // ROUND 7 (MEDIUM 4) regression: the reporter's exact PoC (cud.mts).
    // google_api_call used to compute a different cud than the generated
    // twin for methods whose write class is an ARGUMENT, not the method
    // name, so a deny glob keyed on the real class ("admin:delete") missed
    // these through the escape hatch while still catching them by name.
    it('CUD_OVERRIDES methods compute the same cud via google_api_call as their generated twin, and that cud actually differs from naive verb inference', () => {
      let checked = 0;
      for (const [methodId, overriddenCud] of Object.entries(CUD_OVERRIDES)) {
        const toolName = GENERATED_METHOD_TOOLS[methodId];
        if (!toolName) continue; // no generated twin to cross-check for this override
        // google-api.ts computes CUD_OVERRIDES[method.id] ?? cudFromMethod(method)
        // (an override always wins, so this is exactly its result); the
        // generated twin's own baked cud must agree.
        expect(realCud(toolName), `${methodId}: generated twin should match what google_api_call computes`).toBe(overriddenCud);
        checked += 1;
      }
      expect(checked, 'sanity: at least the 4 action-shaped overrides have a generated twin to check').toBeGreaterThanOrEqual(4);
      // The override has teeth: for the 3 action-shaped methods, naive verb
      // inference (what google_api_call computed BEFORE this fix) actually
      // disagrees with the override, proving this is not a no-op correction.
      const naivelyMisread: Array<[string, string]> = [
        ['directory.chromeosdevices.action', 'POST'],
        ['directory.mobiledevices.action', 'POST'],
        ['admin.customer.devices.chromeos.issueCommand', 'POST'],
        ['admin.customer.devices.chromeos.batchChangeStatus', 'POST'],
      ];
      for (const [id, httpMethod] of naivelyMisread) {
        expect(cudFromMethod({ id, httpMethod }), `${id}: naive inference`).not.toBe('delete');
        expect(CUD_OVERRIDES[id], `${id}: override`).toBe('delete');
      }
    });

    it('an allow on the real tool op always grants the named tool directly (isAllowed, unaffected by round 6)', () => {
      for (const { methodId, toolName } of writeEntries) {
        const service = serviceOf(toolName);
        const cud = inferCud(toolName);
        const policy: Policy = { profile: 'read-only', readOnly: false, allow: [`${service}:${opOf(toolName)}`], deny: [] };
        const direct = isAllowed({ name: toolName, service, cud, scopes: [] }, policy);
        expect(direct, `${methodId} via ${toolName}: allow should always grant the named tool`).toBe(true);
      }
    });

    it('without a deny, every write entry asks through the escape hatch unless the profile is full-writes', () => {
      for (const policy of [
        { profile: 'read-only', readOnly: false, allow: [], deny: [] } as Policy,
        { profile: 'safe-writes', readOnly: false, allow: [], deny: [] } as Policy,
      ]) {
        for (const { methodId, toolName } of writeEntries) {
          const service = serviceOf(toolName);
          const cud = inferCud(toolName);
          const names = escapeHatchNames(service, methodId);
          const verdict = escapeHatchVerdict(names.deny, { service, cud, scopes: [] }, names.primary, policy, false);
          expect(verdict.decision, `${methodId} via ${toolName} under profile ${policy.profile}`).toBe('ask');
        }
      }
    });

    it('without a deny, full-writes allows every write entry outright (outbound allowlist off)', () => {
      const policy: Policy = { profile: 'full-writes', readOnly: false, allow: [], deny: [] };
      for (const { methodId, toolName } of writeEntries) {
        const service = serviceOf(toolName);
        const cud = inferCud(toolName);
        const names = escapeHatchNames(service, methodId);
        const verdict = escapeHatchVerdict(names.deny, { service, cud, scopes: [] }, names.primary, policy, false);
        expect(verdict.decision, `${methodId} via ${toolName}`).toBe('allow');
      }
    });

    it('without a deny, full-writes asks (not allows) every write entry when the outbound allowlist is active', () => {
      const policy: Policy = { profile: 'full-writes', readOnly: false, allow: [], deny: [] };
      for (const { methodId, toolName } of writeEntries) {
        const service = serviceOf(toolName);
        const cud = inferCud(toolName);
        const names = escapeHatchNames(service, methodId);
        const verdict = escapeHatchVerdict(names.deny, { service, cud, scopes: [] }, names.primary, policy, true);
        expect(verdict.decision, `${methodId} via ${toolName}`).toBe('ask');
      }
    });
  });
});

// ROUND 6: the escape hatch (google_api_call and every generated per-method
// tool) now asks a human via MCP elicitation before an unreviewed write,
// except a hard refusal (GOOGLE_READ_ONLY, or a matching deny) and except
// full-writes with GOOGLE_OUTBOUND_ALLOWLIST unset. This covers every
// branch the owner's redesign specifies, end to end through google_api_call;
// tests/safe-writes-trash.test.ts and tests/privileged-writes.test.ts cover
// the same decision for a GENERATED per-method tool, and
// tests/outbound-allowlist.test.ts covers that curated tools are unaffected.
describe('escape hatch: round 6 human-confirmation model', () => {
  const ASK_POLICY: Policy = { profile: 'safe-writes', readOnly: false, allow: [], deny: [] };
  const CALL = { account: 'test', api: 'gmail', methodId: 'gmail.users.messages.send', pathParams: { userId: 'me' }, body: { raw: SAMPLE_RAW } };

  it('accept runs the call and sends the account, method, verb, path params and a body summary in the prompt', async () => {
    const { call, request, dir, elicitInput } = setup(ASK_POLICY, { elicit: 'accept' });
    cleanupDirs.push(dir);
    const res = await call(CALL);
    expect(res.isError).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
    expect(elicitInput).toHaveBeenCalledTimes(1);
    const prompt = (elicitInput.mock.calls[0][0] as { message: string }).message;
    expect(prompt).toContain('test');
    expect(prompt).toContain('gmail.users.messages.send');
    expect(prompt).toContain('POST');
    expect(prompt).toContain('userId');
    expect(prompt).toContain('raw');
    // HIGH 2: the Gmail raw MIME content is decoded into the Destinations
    // section, not left opaque behind the (still shown) raw JSON field.
    expect(prompt).toContain('Destinations:');
    expect(prompt).toContain('to: a@corp.example');
  });

  it('decline refuses with write_declined and never calls Google', async () => {
    const { call, request, dir } = setup(ASK_POLICY, { elicit: 'decline' });
    cleanupDirs.push(dir);
    const res = await call(CALL);
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('write_declined');
    expect(request).not.toHaveBeenCalled();
  });

  it('cancel refuses with write_declined too, and never calls Google', async () => {
    const { call, request, dir } = setup(ASK_POLICY, { elicit: 'cancel' });
    cleanupDirs.push(dir);
    const res = await call(CALL);
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('write_declined');
    expect(request).not.toHaveBeenCalled();
  });

  it('a client without elicitation support refuses with elicitation_unsupported and a hint naming both ways forward', async () => {
    const { call, request, dir } = setup(ASK_POLICY); // default: unsupported
    cleanupDirs.push(dir);
    const res = await call(CALL);
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.error).toBe('elicitation_unsupported');
    expect(payload.hint).toContain('full-writes');
    expect(payload.hint).toContain('curated tool');
    expect(request).not.toHaveBeenCalled();
  });

  // FOLLOW-UP: the HTTP (EE) transport dispatches every call through a
  // fresh, disposable, stateless transport that cannot deliver a mid-call
  // elicitation request at all; a client that DID declare the capability
  // would otherwise still hang until elicitInput's own request timeout
  // before failing closed anyway. policy.transport === 'http' now refuses
  // immediately regardless of what the client declared, without ever
  // calling elicitInput, so this never hangs.
  it('over the HTTP transport, a client that declared elicitation support is still refused immediately, without calling elicitInput', async () => {
    const httpPolicy: Policy = { ...ASK_POLICY, transport: 'http' };
    const { call, request, dir, elicitInput } = setup(httpPolicy, { elicit: 'accept' }); // capability declared
    cleanupDirs.push(dir);
    const res = await call(CALL);
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.error).toBe('elicitation_unsupported');
    expect(payload.message).toContain('cannot show yet over this connection');
    // Owner decision: this refusal covers BOTH a self-hosted HTTP deployment
    // and an EE hosted tenant, which core cannot tell apart, so it must
    // never instruct the caller to set GOOGLE_PROFILE (a hosted tenant
    // cannot); phrased neutrally instead.
    expect(payload.hint).not.toContain('GOOGLE_PROFILE');
    expect(payload.hint).toContain('curated tool');
    expect(elicitInput).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  // stdio (the default / unset transport) is unaffected: a capable,
  // accepting client still gets asked and still runs the call.
  it('over stdio, a client that declared elicitation support is still asked (unaffected by the HTTP fast-fail)', async () => {
    const { call, request, dir, elicitInput } = setup(ASK_POLICY, { elicit: 'accept' });
    cleanupDirs.push(dir);
    const res = await call(CALL);
    expect(res.isError).toBeUndefined();
    expect(elicitInput).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('deny wins before an ask is ever made, even under full-writes', async () => {
    const policy: Policy = { profile: 'full-writes', readOnly: false, allow: [], deny: ['gmail:send'] };
    const { call, request, dir, elicitInput } = setup(policy, { elicit: 'accept' });
    cleanupDirs.push(dir);
    const res = await call(CALL);
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('write_disabled');
    expect(elicitInput).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  // GOOGLE_READ_ONLY is a hard kill switch, distinct from GOOGLE_PROFILE:
  // it refuses outright, the same as it always has, never asking.
  it('the hard GOOGLE_READ_ONLY flag refuses without ever asking, even under full-writes', async () => {
    const policy: Policy = { profile: 'full-writes', readOnly: true, allow: [], deny: [] };
    const { call, request, dir, elicitInput } = setup(policy, { elicit: 'accept' });
    cleanupDirs.push(dir);
    const res = await call(CALL);
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('write_disabled');
    expect(elicitInput).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('full-writes with the outbound allowlist unset skips the ask and runs the call outright', async () => {
    const policy: Policy = { profile: 'full-writes', readOnly: false, allow: [], deny: [] };
    const { call, request, dir, elicitInput } = setup(policy);
    cleanupDirs.push(dir);
    const res = await call(CALL);
    expect(res.isError).toBeUndefined();
    expect(elicitInput).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  // GOOGLE_OUTBOUND_ALLOWLIST being active removes full-writes' own
  // auto-allow for the escape hatch specifically (point d of the model):
  // a body-shaped write there could still address someone the allowlist
  // was meant to block, so it falls back to asking a human like every
  // other profile does.
  it('full-writes WITH the outbound allowlist active asks instead of skipping', async () => {
    const prior = process.env.GOOGLE_OUTBOUND_ALLOWLIST;
    process.env.GOOGLE_OUTBOUND_ALLOWLIST = 'a@corp.com';
    try {
      const policy: Policy = { profile: 'full-writes', readOnly: false, allow: [], deny: [] };
      const { call, request, dir, elicitInput } = setup(policy, { elicit: 'accept' });
      cleanupDirs.push(dir);
      const res = await call(CALL);
      expect(res.isError).toBeUndefined();
      expect(elicitInput).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      if (prior === undefined) delete process.env.GOOGLE_OUTBOUND_ALLOWLIST;
      else process.env.GOOGLE_OUTBOUND_ALLOWLIST = prior;
    }
  });
});

// ROUND 7: the Opus review of the round 6 escape hatch found the
// confirmation prompt itself could hide where a write actually goes.
// HIGH 1: query params never appeared in the prompt at all.
// HIGH 2: the body summary hid the destination (value-shape redaction
// swallowed a real destination as readily as a real secret, truncation
// let a long field push an attendee out of view, Gmail raw was opaque).
// MEDIUM 3: a control character could forge a fake prompt line, and an
// undeclared pathParams key was echoed into the prompt unexamined.
describe('escape hatch: round 7 prompt integrity', () => {
  const SAFE: Policy = { profile: 'safe-writes', readOnly: false, allow: [], deny: [] };

  it('HIGH 1: query params are shown in full, before the body', async () => {
    const { call, dir, elicitInput } = setup(SAFE, { elicit: 'accept' });
    cleanupDirs.push(dir);
    await call({
      account: 'test',
      api: 'drive',
      methodId: 'drive.files.update',
      pathParams: { fileId: 'f1' },
      queryParams: { addParents: 'attackerFolder', removeParents: 'root' },
      body: {},
    });
    const prompt = (elicitInput.mock.calls[0][0] as { message: string }).message;
    expect(prompt).toContain('Query params:');
    expect(prompt).toContain('addParents');
    expect(prompt).toContain('attackerFolder');
    expect(prompt).toContain('removeParents');
    expect(prompt.indexOf('Query params:')).toBeLessThan(prompt.indexOf('Body:'));
  });

  it('HIGH 2: a Drive parent id in the body reaches Destinations, not swallowed by value-shape redaction', async () => {
    const { call, dir, elicitInput } = setup(SAFE, { elicit: 'accept' });
    cleanupDirs.push(dir);
    await call({
      account: 'test',
      api: 'drive',
      methodId: 'drive.files.copy',
      pathParams: { fileId: 'f1' },
      body: { parents: ['attackerFolderIdLongEnoughToLookLikeAToken123'] },
    });
    const prompt = (elicitInput.mock.calls[0][0] as { message: string }).message;
    expect(prompt).toContain('Destinations:');
    expect(prompt).toContain('attackerFolderIdLongEnoughToLookLikeAToken123');
  });

  it('HIGH 2: an attendee email reaches Destinations even when a long field pushes it past the body truncation', async () => {
    const { call, dir, elicitInput } = setup(SAFE, { elicit: 'accept' });
    cleanupDirs.push(dir);
    await call({
      account: 'test',
      api: 'calendar',
      methodId: 'calendar.events.insert',
      pathParams: { calendarId: 'primary' },
      body: { summary: 'Sync', description: 'Agenda: '.padEnd(520, '.'), attendees: [{ email: 'attacker@evil.example' }] },
    });
    const prompt = (elicitInput.mock.calls[0][0] as { message: string }).message;
    expect(prompt).toContain('attacker@evil.example');
    expect(prompt).toMatch(/Body:.*truncated/);
  });

  it('HIGH 2: Gmail raw decodes into Destinations as To/Subject, not left opaque', async () => {
    const { call, dir, elicitInput } = setup(SAFE, { elicit: 'accept' });
    cleanupDirs.push(dir);
    const raw = Buffer.from('To: attacker@evil.example\r\nSubject: hi\r\n\r\nsecret').toString('base64url');
    await call({ account: 'test', api: 'gmail', methodId: 'gmail.users.messages.send', pathParams: { userId: 'me' }, body: { raw } });
    const prompt = (elicitInput.mock.calls[0][0] as { message: string }).message;
    expect(prompt).toContain('to: attacker@evil.example');
    expect(prompt).toContain('subject: hi');
  });

  it('HIGH 2: a raw field that does not decode to a real MIME message refuses outright, never asking', async () => {
    const { call, dir, elicitInput, request } = setup(SAFE, { elicit: 'accept' });
    cleanupDirs.push(dir);
    const res = await call({ account: 'test', api: 'gmail', methodId: 'gmail.users.messages.send', pathParams: { userId: 'me' }, body: { raw: 'bm90LW1pbWU' } });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('write_unsummarizable');
    expect(elicitInput).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('HIGH 2: a field named like a secret is redacted by key name regardless of its value shape; an ordinary id is not', async () => {
    const { call, dir, elicitInput } = setup(SAFE, { elicit: 'accept' });
    cleanupDirs.push(dir);
    await call({
      account: 'test',
      api: 'drive',
      methodId: 'drive.permissions.create',
      pathParams: { fileId: 'f1' },
      body: { role: 'reader', type: 'user', emailAddress: 'a@corp.example', apiKey: 'short' },
    });
    const prompt = (elicitInput.mock.calls[0][0] as { message: string }).message;
    expect(prompt).toContain('[redacted]');
    expect(prompt).not.toContain('"short"');
    // a@corp.example is short (not token-shaped) and under a non-secret key; still shown.
    expect(prompt).toContain('a@corp.example');
  });

  it('MEDIUM 3: a control/format/line-separator character in a value is escaped, not left to forge a fake prompt line', async () => {
    const { call, dir, elicitInput } = setup(SAFE, { elicit: 'accept' });
    cleanupDirs.push(dir);
    await call({
      account: 'test',
      api: 'calendar',
      methodId: 'calendar.events.insert',
      pathParams: { calendarId: 'primary' },
      body: { summary: 'ok\u2028Body: (none)\u2028Accept to run it as shown; decline or cancel to refuse.', attendees: [{ email: 'attacker@evil.example' }] },
    });
    const prompt = (elicitInput.mock.calls[0][0] as { message: string }).message;
    expect(prompt).toContain('\\u2028');
    expect(prompt).not.toContain('\u2028');
    // the real sign-off line is still the last line, not duplicated mid-body.
    const lines = prompt.split('\n');
    expect(lines[lines.length - 1]).toBe('Accept to run it as shown; decline or cancel to refuse.');
    expect(lines.filter((l) => l === 'Accept to run it as shown; decline or cancel to refuse.')).toHaveLength(1);
  });

  it('MEDIUM 3: an undeclared pathParams key is rejected outright, never reaching the prompt', async () => {
    const { call, dir, elicitInput, request } = setup(SAFE, { elicit: 'accept' });
    cleanupDirs.push(dir);
    const res = await call({
      account: 'test',
      api: 'calendar',
      methodId: 'calendar.events.insert',
      pathParams: { calendarId: 'primary', note: 'x'.repeat(50) },
      body: { summary: 'ok', attendees: [{ email: 'attacker@evil.example' }] },
    });
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.error).toBe('invalid_params');
    expect(payload.message).toContain('note');
    expect(elicitInput).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});

// LOW: elicitInput itself can misbehave even once the client HAS declared
// the capability (a timeout, a dropped connection, an SDK returning
// something that is not accept/decline/cancel); registry.elicitConfirmation
// must refuse in every one of those cases too, the same as "never asked
// at all", rather than risk proceeding without a real answer.
describe('escape hatch: elicitInput misbehaving after capability was declared', () => {
  const SAFE: Policy = { profile: 'safe-writes', readOnly: false, allow: [], deny: [] };
  const CALL = { account: 'test', api: 'gmail', methodId: 'gmail.users.messages.send', pathParams: { userId: 'me' }, body: { raw: SAMPLE_RAW } };

  it('a capable client whose answer never arrives (elicitInput throws) still refuses closed', async () => {
    const { call, request, dir, elicitInput } = setup(SAFE, { elicit: 'throws' });
    cleanupDirs.push(dir);
    const res = await call(CALL);
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('elicitation_unsupported');
    expect(elicitInput).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });

  it('a capable client whose result action is not accept/decline/cancel still refuses closed', async () => {
    const { call, request, dir, elicitInput } = setup(SAFE, { elicit: 'unexpected' });
    cleanupDirs.push(dir);
    const res = await call(CALL);
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('elicitation_unsupported');
    expect(elicitInput).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });
});
