import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildRegistry, requestHooksFor } from '../src/compose.js';
import { buildIdentityContext, isOwnerContext, type IdentityContext } from '../src/identity.js';
import { clearDiscoveryMemoryCache } from '../src/discovery-client.js';
import type { AccountSet } from '../src/accounts.js';
import type { ScopeProfile } from '../src/scope-catalog.js';

// buildRegistry must resolve every handler through the context it is given.
// tests/setup.ts seeds the GLOBAL registry with `test:test@example.com`, and
// every context below reuses the alias `test`: wherever a handler fell back to
// the process global it would surface test@example.com (or the global token
// store), so each case fails against a registry that ignores its context.

type Result = { content: { text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>, extra?: unknown) => Promise<Result>;
type Req = { url: string; method?: string; data?: unknown };

interface Row {
  email: string;
  admin?: boolean;
  scopeProfile?: string;
}

function setWith(rows: Record<string, Row>, opts: { defaultAccount?: string; scopeProfiles?: Record<string, ScopeProfile> } = {}): AccountSet {
  const configs: AccountSet['configs'] = {};
  for (const [alias, r] of Object.entries(rows)) {
    configs[alias] = {
      email: r.email,
      tokenPath: `/nonexistent/${alias}/token.json`,
      encPath: `/nonexistent/${alias}.enc`,
      source: 'config',
      ...(r.admin ? { admin: true } : {}),
      ...(r.scopeProfile ? { scopeProfile: r.scopeProfile } : {}),
    };
  }
  return {
    aliases: Object.keys(rows),
    configs,
    scopeProfiles: { base: { bundles: [] }, ...opts.scopeProfiles },
    source: 'file',
    stamp: '1:0',
    ...(opts.defaultAccount ? { defaultAccount: opts.defaultAccount, defaultAccountSource: 'config' as const } : {}),
  };
}

function fakeServer() {
  const handlers: Record<string, Handler> = {};
  const schemas: Record<string, Record<string, unknown>> = {};
  const server = {
    registerTool: (name: string, config: { inputSchema?: Record<string, unknown> }, handler: Handler) => {
      handlers[name] = handler;
      schemas[name] = config.inputSchema ?? {};
      return 'ok';
    },
    sendToolListChanged: vi.fn(),
    server: { setRequestHandler: () => {}, getClientCapabilities: () => undefined },
  };
  return { server, handlers, schemas };
}

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

function contextFor(
  subject: string,
  set: AccountSet,
  opts: { scope?: string; requestImpl?: (req: Req) => Promise<unknown> } = {},
) {
  const request = vi.fn(opts.requestImpl ?? (async () => ({ data: {}, headers: new Headers() })));
  const getClient = vi.fn(async () => ({ request }));
  const token = {
    access_token: `at-${subject}`,
    refresh_token: `rt-${subject}`,
    scope: opts.scope ?? GMAIL_SCOPE,
    token_type: 'Bearer',
    expiry_date: Date.now() + 3_600_000,
  };
  const tokenStore = {
    readToken: vi.fn(() => token),
    writeToken: vi.fn(),
    updateToken: vi.fn(),
    hasToken: vi.fn(() => true),
  };
  const ctx = {
    subject,
    accounts: set,
    policy: { profile: 'full-writes', readOnly: false, allow: [], deny: [] },
    getClient,
    tokenStore,
  } as unknown as IdentityContext;
  const { server, handlers, schemas } = fakeServer();
  buildRegistry(server as never, ctx, 'eager');
  return { ctx, request, getClient, tokenStore, handlers, schemas };
}

type Built = ReturnType<typeof contextFor>;

const parse = (r: Result) => JSON.parse(r.content[0].text);
const WIZARD = ['account_add', 'account_reauth', 'account_write_config'];
const HOST_FILE_TOOLS = ['drive_upload', 'drive_download', 'drive_export', 'gmail_download_attachment'];

let A: Built;
let B: Built;

beforeAll(() => {
  A = contextFor(
    'ctx-a',
    setWith(
      { test: { email: 'a-test@ctx-a.example', admin: true }, second: { email: 'a-second@ctx-a.example' } },
      { defaultAccount: 'test' },
    ),
  );
  B = contextFor('ctx-b', setWith({ test: { email: 'b-test@ctx-b.example' } }));
}, 60_000);

afterEach(() => {
  for (const c of [A, B]) {
    c.request.mockClear();
    c.getClient.mockClear();
    c.tokenStore.readToken.mockClear();
    c.tokenStore.hasToken.mockClear();
  }
});

const untouched = (c: Built) => {
  expect(c.getClient).not.toHaveBeenCalled();
  expect(c.request).not.toHaveBeenCalled();
};

describe('buildRegistry resolves every handler through its context', () => {
  it('curated tools use the context client', async () => {
    await A.handlers.gmail_search({ account: 'test', query: 'x' });
    expect(A.getClient).toHaveBeenCalledWith('test');
    untouched(B);
  });

  it('generated tools use the context client', async () => {
    await A.handlers.gmail_users_labels_get({ account: 'test', userId: 'me', id: 'L1' });
    const urls = A.request.mock.calls.map(([req]) => (req as Req).url);
    expect(urls.some((u) => u.includes('/gmail/v1/users/me/labels/L1'))).toBe(true);
    untouched(B);
  });

  it('a generated 403 scope hint reads the context token and profile', async () => {
    const denied = async () => {
      throw { code: 403, errors: [{ reason: 'insufficientPermissions' }], message: 'Insufficient Permission' };
    };
    // keep is outside the base profile: only a profile read through the
    // context can call the scope "in test's profile but not granted".
    const C = contextFor(
      'ctx-c',
      setWith({ test: { email: 'c-test@ctx-c.example', scopeProfile: 'notes' } }, { scopeProfiles: { notes: { bundles: ['keep'] } } }),
      { scope: '', requestImpl: denied },
    );
    const res = await C.handlers.keep_notes_list({ account: 'test' });
    const env = parse(res);
    expect(env.error).toBe('insufficient_scope');
    expect(env.hint).toContain("in test's profile but not granted");
    expect(C.tokenStore.readToken).toHaveBeenCalledWith('test');
    expect(A.tokenStore.readToken).not.toHaveBeenCalled();
    expect(B.tokenStore.readToken).not.toHaveBeenCalled();
  });

  it('account_list lists only the context accounts, token health and admin flags', async () => {
    const out = parse(await A.handlers.account_list({}));
    expect(out.defaultAccount).toBe('test');
    expect(out.accounts.map((a: { email: string }) => a.email)).toEqual(['a-test@ctx-a.example', 'a-second@ctx-a.example']);
    const test = out.accounts.find((a: { alias: string }) => a.alias === 'test');
    expect(test.admin).toBe(true);
    for (const a of out.accounts) expect(a.token.status).toBe('ok');
    expect(A.tokenStore.hasToken).toHaveBeenCalled();
    expect(B.tokenStore.hasToken).not.toHaveBeenCalled();
    const text = JSON.stringify(out);
    expect(text).not.toContain('test@example.com');
    expect(text).not.toContain('ctx-b');
  });

  const decodeRaw = (req: Req | undefined): string => {
    expect(req).toBeDefined();
    const data = req!.data as { raw?: string; message?: { raw: string } };
    return Buffer.from(data.message?.raw ?? data.raw ?? '', 'base64url').toString('utf-8');
  };

  it('gmail_send sends From the context account', async () => {
    await A.handlers.gmail_send({ account: 'test', to: 'x@y.example', subject: 's', body: 'b' });
    const mime = decodeRaw(A.request.mock.calls.map(([r]) => r as Req).find((r) => r.url.includes('/messages/send')));
    expect(mime).toMatch(/^From: .*a-test@ctx-a\.example/m);
    expect(mime).not.toContain('test@example.com');
    untouched(B);
  });

  it('gmail_create_draft sends From the context account', async () => {
    await A.handlers.gmail_create_draft({ account: 'test', to: 'x@y.example', subject: 's', body: 'b' });
    const mime = decodeRaw(A.request.mock.calls.map(([r]) => r as Req).find((r) => r.url.includes('/drafts')));
    expect(mime).toMatch(/^From: .*a-test@ctx-a\.example/m);
    expect(mime).not.toContain('test@example.com');
    untouched(B);
  });

  it('drive_transfer shares with the context account email', async () => {
    let granted: string | undefined;
    const T = contextFor(
      'ctx-t',
      setWith({ test: { email: 't-test@ctx-t.example' }, second: { email: 't-second@ctx-t.example' } }),
      {
        requestImpl: async (req) => {
          const method = (req.method ?? 'GET').toUpperCase();
          if (method === 'POST' && /\/files\/F1\/permissions/.test(req.url)) {
            granted = (req.data as { emailAddress?: string }).emailAddress;
            return { data: { id: 'P1' }, headers: new Headers() };
          }
          if (method === 'GET' && /\/files\/F1(\?|$)/.test(req.url)) {
            return { data: { id: 'F1', name: 'f.txt', mimeType: 'text/plain' }, headers: new Headers() };
          }
          return { data: { id: 'C1', name: 'f.txt' }, headers: new Headers() };
        },
      },
    );
    await T.handlers.drive_transfer({ fromAccount: 'second', toAccount: 'test', fileId: 'F1' });
    expect(granted).toBe('t-test@ctx-t.example');
    untouched(A);
    untouched(B);
  });

  it('diagnose reports and probes only the context accounts', async () => {
    const report = parse(await A.handlers.diagnose({}));
    const ids = report.sections.map((s: { id: number }) => s.id);
    expect(ids).not.toContain(3);
    expect(ids).not.toContain(7);
    const s4 = report.sections.find((s: { id: number }) => s.id === 4);
    expect(s4.lines.join('\n')).toContain('a-test@ctx-a.example');
    const text = JSON.stringify(report);
    expect(text).not.toContain('test@example.com');
    expect(text).not.toContain('ctx-b');
    const urls = A.request.mock.calls.map(([r]) => (r as Req).url);
    expect(urls).toContain('https://gmail.googleapis.com/gmail/v1/users/me/profile');
    untouched(B);
  });

  it('a context claiming the owner subject gets none of the owner surfaces', async () => {
    for (const name of WIZARD) expect(A.handlers[name]).toBeUndefined();
    const forged = contextFor('owner', setWith({ test: { email: 'f-test@ctx-f.example' } }));
    expect(isOwnerContext(forged.ctx)).toBe(false);
    for (const name of [...WIZARD, ...HOST_FILE_TOOLS]) expect(forged.handlers[name], name).toBeUndefined();
    expect(forged.schemas.drive_update).not.toHaveProperty('localPath');
    const ids = parse(await forged.handlers.diagnose({})).sections.map((s: { id: number }) => s.id);
    expect(ids).not.toContain(3);
    expect(ids).not.toContain(7);
  });

  it('a non-owner context gets no host-file tools, params or reads', async () => {
    for (const name of HOST_FILE_TOOLS) expect(A.handlers[name], name).toBeUndefined();
    expect(A.schemas.drive_update).not.toHaveProperty('localPath');
    expect(A.schemas.gmail_send).not.toHaveProperty('attachments');
    expect(A.schemas.gmail_create_draft).not.toHaveProperty('attachments');
    const upd = await A.handlers.drive_update({ account: 'test', fileId: 'F1', localPath: '/etc/hostname' });
    expect(upd.isError).toBe(true);
    const mail = { account: 'test', to: 'x@y.example', subject: 's', body: 'b', attachments: [{ path: '/etc/hostname' }] };
    for (const tool of ['gmail_send', 'gmail_create_draft']) {
      const res = await A.handlers[tool](mail);
      expect(res.isError, tool).toBe(true);
    }
    untouched(A);
  });

  it('the tenant diagnose config section reads no operator host state', async () => {
    const s2 = parse(await A.handlers.diagnose({})).sections.find((s: { id: number }) => s.id === 2);
    expect(s2.lines).toEqual(['2 account(s) configured']);
    expect(s2.hint).toBeUndefined();
  });
});

describe('google_api_call resolves through its context', () => {
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
            scopes: ['https://www.googleapis.com/auth/webmasters.readonly', 'https://www.googleapis.com/auth/webmasters'],
          },
        },
      },
    },
  };
  let dir: string;
  const prev = process.env.DISCOVERY_CACHE_PATH;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-thread-discovery-'));
    fs.writeFileSync(path.join(dir, 'searchconsole.json'), JSON.stringify(SEARCHCONSOLE_FIXTURE));
    process.env.DISCOVERY_CACHE_PATH = dir;
    clearDiscoveryMemoryCache();
    return () => {
      if (prev === undefined) delete process.env.DISCOVERY_CACHE_PATH;
      else process.env.DISCOVERY_CACHE_PATH = prev;
      clearDiscoveryMemoryCache();
      fs.rmSync(dir, { recursive: true, force: true });
    };
  });

  it('dispatches with the context client', async () => {
    const res = await A.handlers.google_api_call({ account: 'test', api: 'searchconsole', methodId: 'webmasters.sites.list' });
    expect(res.isError, res.content[0].text).toBeFalsy();
    expect(A.getClient).toHaveBeenCalledWith('test');
    untouched(B);
  });

  it('a 403 scope hint reads the context token', async () => {
    const denied = async () => {
      throw { code: 403, errors: [{ reason: 'insufficientPermissions' }], message: 'Insufficient Permission' };
    };
    const D = contextFor('ctx-d', setWith({ test: { email: 'd-test@ctx-d.example' } }), { scope: '', requestImpl: denied });
    const env = parse(await D.handlers.google_api_call({ account: 'test', api: 'searchconsole', methodId: 'webmasters.sites.list' }));
    expect(env.error).toBe('insufficient_scope');
    expect(D.tokenStore.readToken).toHaveBeenCalledWith('test');
    expect(A.tokenStore.readToken).not.toHaveBeenCalled();
  });
});

describe('the owner context keeps the single-owner surface', () => {
  let owner: ReturnType<typeof fakeServer>['handlers'];
  let ownerSchemas: ReturnType<typeof fakeServer>['schemas'];

  beforeAll(() => {
    const ctx = buildIdentityContext({} as NodeJS.ProcessEnv);
    expect(isOwnerContext(ctx)).toBe(true);
    const { server, handlers, schemas } = fakeServer();
    buildRegistry(server as never, ctx, 'eager');
    owner = handlers;
    ownerSchemas = schemas;
  }, 60_000);

  it('lists the global accounts', async () => {
    const out = parse(await owner.account_list({}));
    expect(out.accounts.map((a: { alias: string; email: string }) => [a.alias, a.email])).toEqual([['test', 'test@example.com']]);
  });

  it('keeps the wizard, host-file tools and their params', () => {
    for (const name of [...WIZARD, ...HOST_FILE_TOOLS]) expect(owner[name], name).toBeDefined();
    expect(ownerSchemas.drive_update).toHaveProperty('localPath');
    expect(ownerSchemas.gmail_send).toHaveProperty('attachments');
    expect(ownerSchemas.gmail_create_draft).toHaveProperty('attachments');
  });

  it('keeps the operator diagnose report over the global accounts', async () => {
    const report = parse(await owner.diagnose({}));
    const ids = report.sections.map((s: { id: number }) => s.id);
    expect(ids).toContain(3);
    const s4 = report.sections.find((s: { id: number }) => s.id === 4);
    expect(s4.lines.join('\n')).toContain('test@example.com');
    const s2 = report.sections.find((s: { id: number }) => s.id === 2);
    expect(s2.lines.some((l: string) => l.startsWith('local usage metrics:'))).toBe(true);
  });
});

describe('requestHooksFor binds the per-request hooks to one registry', () => {
  it('names the context default account and screens against its registry', () => {
    const { server } = fakeServer();
    const ctx = contextFor('ctx-h', setWith({ only: { email: 'h@ctx-h.example' } }, { defaultAccount: 'only' })).ctx;
    const registry = buildRegistry(server as never, ctx, 'eager');
    const hooks = requestHooksFor(registry, ctx, null, {} as NodeJS.ProcessEnv);
    expect(hooks.validationEnvelope?.defaultAccount?.()).toBe('only');
    expect(hooks.validationEnvelope?.isKnownTool?.('gmail_search')).toBe(true);
    expect(hooks.validationEnvelope?.isKnownTool?.('nope_tool')).toBe(false);
    expect(hooks.argShapeFor?.('gmail_search')).toBeDefined();
    expect(hooks.strictArgs?.declaredFor('gmail_search')).toContain('query');
  });

  it('turns each hook off with its env switch', () => {
    const { server } = fakeServer();
    const ctx = contextFor('ctx-i', setWith({ only: { email: 'i@ctx-i.example' } })).ctx;
    const registry = buildRegistry(server as never, ctx, 'eager');
    const hooks = requestHooksFor(registry, ctx, null, { GOOGLE_ARG_NORMALIZE: 'off', GOOGLE_ARG_UNKNOWN: 'off' } as NodeJS.ProcessEnv);
    expect(hooks.argShapeFor).toBeUndefined();
    expect(hooks.strictArgs).toBeUndefined();
  });
});

