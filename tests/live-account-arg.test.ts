import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../src/registry.js';
import { accountArgLive } from '../src/accounts.js';
import type { AccountSet } from '../src/accounts.js';
import type { Policy } from '../src/write-control.js';

// S1.10-A: the generic mid-session account_add mechanism. Validation is LIVE
// (accountArgLive consults the accessor at parse time) and tools/list
// advertises the CURRENT enum (injected per call over the cached structural
// schema) — accounts-config.md section 4 test #4.

const POLICY: Policy = { profile: 'full-writes', readOnly: false, allow: [], deny: [] };

const setOf = (aliases: string[]): AccountSet =>
  ({
    aliases,
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
