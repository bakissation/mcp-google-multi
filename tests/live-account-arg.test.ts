import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../src/registry.js';
import { accountArgLive } from '../src/accounts.js';
import type { AccountSet } from '../src/accounts.js';
import type { Policy } from '../src/write-control.js';
import { SERVICES } from '../src/services.js';
import { GENERATED_SERVICES } from '../src/tools/generated/index.js';

// S1.10-A: the generic mid-session account_add mechanism. Validation is LIVE
// (accountArgLive consults the accessor at parse time) and tools/list
// advertises the CURRENT enum (injected per call over the cached structural
// schema) — accounts-config.md section 4 test #4.

const POLICY: Policy = { profile: 'full-writes', readOnly: false, allow: [], deny: [] };

// A fresh array per call, as invalidateAccountSet() yields a new set: sharing
// one mutable array would hide a field that captured the boot-time list.
const setOf = (aliases: string[]): AccountSet =>
  ({
    aliases: [...aliases],
    configs: Object.fromEntries(
      aliases.map((a) => [a, { email: `${a}@x.example`, tokenPath: `/x/${a}/t.json`, encPath: `/x/${a}.enc`, source: 'env' as const }]),
    ),
    scopeProfiles: { base: { bundles: [] } },
    source: 'env',
    stamp: 'env:0',
  }) as AccountSet;

function harness(initial: string[]) {
  const aliases = [...initial];
  const captured: { name: string; config: { inputSchema: Record<string, z.ZodType> } }[] = [];
  const stub = {
    registerTool: (name: string, config: never) => {
      captured.push({ name, config });
      return 'ok';
    },
    sendToolListChanged: vi.fn(),
    server: { setRequestHandler: () => {} },
  };
  const registry = new ToolRegistry(stub as never, POLICY, 'eager', null, () => setOf(aliases));
  return { registry, captured, aliases };
}

describe('accountArgLive (S1.10-A)', () => {
  it('an alias added AFTER registration is immediately valid on the already-registered schema', () => {
    const { registry, captured, aliases } = harness(['first']);
    registry.registerTool(
      'thing_update',
      { description: 'write tool with a live account arg', inputSchema: { account: accountArgLive(() => aliases).optional() } },
      (async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })) as never,
    );
    const schema = captured.find((t) => t.name === 'thing_update')!.config.inputSchema.account;
    expect(schema.safeParse('first').success).toBe(true);
    expect(schema.safeParse('second').success).toBe(false);
    aliases.push('second'); // the account_add moment — no re-registration
    expect(schema.safeParse('second').success).toBe(true);
    const err = schema.safeParse('nope');
    expect(err.success).toBe(false);
  });

  it('an empty alias set stays permissive (empty-safe rule)', () => {
    const empty: string[] = [];
    expect(accountArgLive(() => empty).safeParse('anything').success).toBe(true);
  });
});

describe('tools/list advertises the LIVE enum (S1.10-A)', () => {

  it('the account enum tracks the live set across an add, on the SAME cached schema', async () => {
    const { registry, aliases } = harness(['first']);
    let listHandler: (() => Promise<{ tools: { name: string; inputSchema: { properties?: Record<string, { enum?: unknown[] }> } }[] }>) | undefined;
    const stubInner = (registry as unknown as { server: { server: { setRequestHandler: (m: string, h: never) => void } } }).server.server;
    stubInner.setRequestHandler = (method: string, h: never) => {
      if (method === 'tools/list') listHandler = h as never;
    };
    registry.registerTool(
      'thing_update',
      { description: 'write tool', inputSchema: { account: accountArgLive(() => aliases).optional().describe('Google account alias') } },
      (async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })) as never,
    );
    registry.installListHandler();

    const first = (await listHandler!()).tools.find((t) => t.name === 'thing_update')!;
    expect(first.inputSchema.properties!.account.enum).toEqual(['first']);

    aliases.push('second');
    const second = (await listHandler!()).tools.find((t) => t.name === 'thing_update')!;
    expect(second.inputSchema.properties!.account.enum).toEqual(['first', 'second']);
  });

  it('the fan-out union refreshes its enum branch and keeps the CSV branch', async () => {
    const { registry, aliases } = harness(['first', 'other']);
    let listHandler: (() => Promise<{ tools: { name: string; inputSchema: { properties?: Record<string, { anyOf?: { enum?: unknown[] }[] }> } }[] }>) | undefined;
    const stubInner = (registry as unknown as { server: { server: { setRequestHandler: (m: string, h: never) => void } } }).server.server;
    stubInner.setRequestHandler = (method: string, h: never) => {
      if (method === 'tools/list') listHandler = h as never;
    };
    // a READ tool with an enum-shaped account joins the fan-out path (S1.8),
    // whose field is the union enum | CSV
    registry.registerTool(
      'thing_search',
      { description: 'read tool', inputSchema: { account: z.enum(['first', 'other']).optional().describe('Google account alias') } },
      (async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })) as never,
    );
    registry.installListHandler();

    aliases.push('third');
    const listed = (await listHandler!()).tools.find((t) => t.name === 'thing_search')!;
    const anyOf = listed.inputSchema.properties!.account.anyOf!;
    const enumBranch = anyOf.find((b) => Array.isArray(b.enum))!;
    expect(enumBranch.enum).toEqual(['*', 'first', 'other', 'third']);
    expect(anyOf.length).toBeGreaterThan(1); // the CSV string branch survives
  });
});

// The REAL tool schemas, not synthetic enums: curated tools build their
// account field with accountArgLive, generated tools with accountField(getter).
// A synthetic z.enum hid that live fields were never recognised as selectors,
// so no curated read tool accepted "*" or a CSV.
describe('real tools keep fan-out and validate live', () => {
  type Shape = Record<string, z.ZodType>;
  function realRegistry(initial: string[]) {
    const h = harness(initial);
    let listHandler: (() => Promise<{ tools: { name: string; inputSchema: { properties?: Record<string, { anyOf?: { enum?: unknown[]; pattern?: string }[]; enum?: unknown[] }> } }[] }>) | undefined;
    const inner = (h.registry as unknown as { server: { server: { setRequestHandler: (m: string, fn: never) => void } } }).server.server;
    inner.setRequestHandler = (method: string, fn: never) => {
      if (method === 'tools/list') listHandler = fn as never;
    };
    for (const s of SERVICES) s.register(h.registry);
    for (const g of GENERATED_SERVICES) g.register(h.registry);
    h.registry.installListHandler();
    const schemaOf = (name: string) => z.object(h.captured.find((t) => t.name === name)!.config.inputSchema as Shape);
    return { ...h, schemaOf, list: () => listHandler!() };
  }

  it('every curated and generated read tool with an account accepts "*" and a CSV', () => {
    const { registry, captured, schemaOf } = realRegistry(['a', 'b']);
    const readTools = captured.filter(
      (t) => 'account' in t.config.inputSchema && registry.catalog(t.name.split('_')[0]).some((op) => op.tool === t.name && op.cud === 'read'),
    );
    const refusing = readTools
      .filter((t) => !['gmail_download_attachment', 'drive_download', 'drive_export'].includes(t.name))
      .filter((t) => !schemaOf(t.name).partial().safeParse({ account: '*' }).success || !schemaOf(t.name).partial().safeParse({ account: 'a,b' }).success)
      .map((t) => t.name);
    expect(readTools.length).toBeGreaterThan(300);
    expect(refusing).toEqual([]);
    expect(schemaOf('gmail_search').partial().safeParse({ account: 'zz' }).success).toBe(false);
  });

  it('an alias added after build is valid on curated and generated tools, read and write', () => {
    const { aliases, schemaOf } = realRegistry(['a']);
    const tools = ['gmail_search', 'gmail_send', 'gmail_users_labels_get', 'gmail_users_drafts_delete'];
    for (const t of tools) expect(schemaOf(t).partial().safeParse({ account: 'fresh' }).success).toBe(false);
    aliases.push('fresh');
    for (const t of tools) expect(schemaOf(t).partial().safeParse({ account: 'fresh' }).success).toBe(true);
    expect(schemaOf('gmail_search').partial().safeParse({ account: 'a,fresh' }).success).toBe(true);
  });

  it('tools/list advertises "*" plus the live aliases on read tools and the live aliases on write tools', async () => {
    const { aliases, registry, list } = realRegistry(['a', 'b']);
    registry.reveal('gmail');
    aliases.push('c');
    const tools = (await list()).tools;
    const account = (n: string) => tools.find((t) => t.name === n)!.inputSchema.properties!.account;
    const selector = account('gmail_search').anyOf!.find((b) => b.pattern === undefined)!;
    expect(selector.enum).toEqual(['*', 'a', 'b', 'c']);
    expect(account('gmail_search').anyOf!.some((b) => typeof b.pattern === 'string')).toBe(true);
    expect(account('gmail_send').enum).toEqual(['a', 'b', 'c']);
  });

  it('"*" over an empty account set is refused, not an empty success', async () => {
    const h = harness([]);
    let handler: ((args: { account?: string }) => Promise<{ content: { text: string }[]; isError?: boolean }>) | undefined;
    (h.registry as unknown as { server: { registerTool: (n: string, c: never, fn: never) => string } }).server.registerTool = (n, _c, fn) => {
      if (n === 'thing_search') handler = fn as never;
      return 'ok';
    };
    const inner = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '{}' }] }));
    h.registry.registerTool(
      'thing_search',
      { description: 'read tool', inputSchema: { account: accountArgLive(() => h.aliases).optional().describe('Google account alias') } },
      inner as never,
    );
    const res = await handler!({ account: '*' });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text)).toMatchObject({ error: 'validation_error', hint: 'No Google account is configured yet. Add one with account_add.' });
    expect(inner).not.toHaveBeenCalled();
  });
});
