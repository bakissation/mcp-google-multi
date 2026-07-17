import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ToolRegistry } from '../src/registry.js';
import { executeApiMethod, buildQueryString } from '../src/executor.js';
import { registerGeneratedTool, type GeneratedToolDef } from '../src/tools/generated/_shared.js';
import { emitService, buildServiceFile, emitBarrel, planTools, toolNameFromId, snakeCase } from '../scripts/gen-tools.js';
import type { Policy } from '../src/write-control.js';

const FULL: Policy = { profile: 'full-writes', readOnly: false, allow: [], deny: [] };
const READ_ONLY: Policy = { profile: 'read-only', readOnly: false, allow: [], deny: [] };

const METHOD = {
  id: 'tasks.tasks.update',
  httpMethod: 'PUT',
  path: 'tasks/v1/lists/{tasklist}/tasks/{task}',
  baseUrl: 'https://tasks.googleapis.com/',
  requiredParams: ['tasklist', 'task'],
};

function harness(policy: Policy) {
  const registered: { name: string; handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }> }[] = [];
  const server = {
    registerTool: (name: string, _config: never, handler: never) => {
      registered.push({ name, handler });
      return 'ok';
    },
    sendToolListChanged: vi.fn(),
    server: { setRequestHandler: () => {} },
  };
  return { registry: new ToolRegistry(server as never, policy), registered };
}

describe('executeApiMethod', () => {
  it('assembles the URL from baked metadata with repeated query keys', async () => {
    const request = vi.fn(async () => ({ data: { ok: true } }));
    const res = await executeApiMethod(
      METHOD,
      {
        account: 'test',
        pathParams: { tasklist: 'l1', task: 't/2' },
        queryParams: { fields: 'id', tags: ['a', 'b'] },
        body: { title: 'x' },
      },
      { getClientFn: (async () => ({ request })) as never },
    );
    expect(res.isError).toBeUndefined();
    const arg = request.mock.calls[0][0] as unknown as { url: string; method: string; data: unknown };
    expect(arg.url).toBe('https://tasks.googleapis.com/tasks/v1/lists/l1/tasks/t%2F2?alt=json&fields=id&tags=a&tags=b');
    expect(arg.method).toBe('PUT');
    expect(arg.data).toEqual({ title: 'x' });
  });

  it('rejects alt=media', async () => {
    const res = await executeApiMethod(METHOD, { account: 'test', queryParams: { alt: 'media' } });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('binary_unsupported');
  });

  it('reports missing path params as invalid_params with the required list', async () => {
    const res = await executeApiMethod(METHOD, { account: 'test', pathParams: { tasklist: 'l1' } });
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.error).toBe('invalid_params');
    expect(payload.hint).toContain('tasklist, task');
  });

  it('refuses non-googleapis hosts', async () => {
    const res = await executeApiMethod(
      { ...METHOD, baseUrl: 'https://evil.example.com/' },
      { account: 'test', pathParams: { tasklist: 'l1', task: 't1' } },
    );
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('untrusted_host');
  });

  it('truncates oversized responses', async () => {
    const request = vi.fn(async () => ({ data: { blob: 'x'.repeat(200_000) } }));
    const res = await executeApiMethod(
      METHOD,
      { account: 'test', pathParams: { tasklist: 'l1', task: 't1' } },
      { getClientFn: (async () => ({ request })) as never },
    );
    const payload = JSON.parse(res.content[0].text);
    expect(payload.truncated).toBe(true);
    expect(payload.totalChars).toBeGreaterThan(100_000);
  });

  it('maps request failures through the error taxonomy', async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error('unauthorized'), { code: 401 });
    });
    const res = await executeApiMethod(
      METHOD,
      { account: 'test', pathParams: { tasklist: 'l1', task: 't1' } },
      { getClientFn: (async () => ({ request })) as never },
    );
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBeTruthy();
  });

  it('always requests alt=json', () => {
    expect(buildQueryString(undefined)).toBe('alt=json');
  });
});

describe('registerGeneratedTool', () => {
  const def: GeneratedToolDef = {
    name: 'tasks_tasks_update',
    cud: 'update',
    description: 'Updates the specified task.',
    method: METHOD,
    params: [
      { field: 'task', api: 'task', location: 'path' },
      { field: 'tasklist', api: 'tasklist', location: 'path' },
      { field: 'account_', api: 'account', location: 'query' },
      { field: 'fields', api: 'fields', location: 'query' },
    ],
    hasBody: true,
    shape: {
      account: z.enum(['test']).describe('Google account alias'),
      task: z.string(),
      tasklist: z.string(),
      account_: z.string().optional(),
      fields: z.string().optional(),
    },
  };

  it('splits args into path/query params, restoring renamed API names', async () => {
    const { registry, registered } = harness(FULL);
    const request = vi.fn(async () => ({ data: { done: true } }));
    registerGeneratedTool(registry, def, { getClientFn: (async () => ({ request })) as never });
    const res = await registered[0].handler({
      account: 'test',
      task: 't1',
      tasklist: 'l1',
      account_: 'acct-param',
      body: { title: 'hi' },
    });
    expect(res.isError).toBeUndefined();
    const arg = request.mock.calls[0][0] as unknown as { url: string; data: unknown };
    expect(arg.url).toContain('/lists/l1/tasks/t1?');
    expect(arg.url).toContain('account=acct-param');
    expect(arg.data).toEqual({ title: 'hi' });
  });

  it('is gated by write-control via the explicit cud even without a verb in the name', async () => {
    const { registry, registered } = harness(READ_ONLY);
    registerGeneratedTool(registry, { ...def, name: 'tasks_frobnicate' });
    const entry = registry.tools.find((t) => t.name === 'tasks_frobnicate');
    expect(entry?.cud).toBe('update');
    const res = await registered[0].handler({ account: 'test', task: 't1', tasklist: 'l1' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('write');
  });

  it('registers as a hidden operational tool under its service', () => {
    const { registry } = harness(FULL);
    registerGeneratedTool(registry, def);
    const entry = registry.tools.find((t) => t.name === def.name);
    expect(entry?.meta).toBe(false);
    expect(entry?.service).toBe('tasks');
    expect(registry.isVisible(entry!)).toBe(false);
  });
});

describe('gen-tools generator', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tasks.v1.json'), 'utf-8'));
  const api = { file: 'tasks.v1.json', service: 'tasks' };

  it('converts camelCase method ids to snake_case tool names', () => {
    expect(snakeCase('getThumbnail')).toBe('get_thumbnail');
    expect(toolNameFromId('slides', 'slides.presentations.pages.getThumbnail')).toBe('slides_presentations_pages_get_thumbnail');
  });

  it('skips curated methods and emits only the long tail', () => {
    const { plans, report } = planTools(doc, api);
    expect(report.skippedCurated).toBe(12);
    expect(plans.map((p) => p.name)).toEqual(['tasks_tasklists_update', 'tasks_tasks_update']);
    expect(plans.every((p) => p.cud === 'update')).toBe(true);
  });

  it('bakes required params and body metadata into each plan', () => {
    const { plans } = planTools(doc, api);
    const update = plans.find((p) => p.name === 'tasks_tasks_update')!;
    expect(update.method.requiredParams.sort()).toEqual(['task', 'tasklist']);
    expect(update.bodyRef).toBe('Task');
    expect(update.bodyProperties).toContain('title');
    expect(update.params.every((p) => p.location === 'path')).toBe(true);
  });

  it('is deterministic and matches the committed generated file', () => {
    const first = buildServiceFile('tasks', [emitService(doc, api).fileText]);
    const second = buildServiceFile('tasks', [emitService(doc, api).fileText]);
    expect(first).toBe(second);
    const committed = fs.readFileSync(path.join(__dirname, '..', 'src', 'tools', 'generated', 'tasks.ts'), 'utf-8');
    expect(first).toBe(committed);
  });

  it('matches the committed barrel', async () => {
    const { GENERATED_SERVICES } = await import('../src/tools/generated/index.js');
    const committed = fs.readFileSync(path.join(__dirname, '..', 'src', 'tools', 'generated', 'index.ts'), 'utf-8');
    expect(emitBarrel(GENERATED_SERVICES.map((s) => s.name))).toBe(committed);
  });

  it('registers a generated-only service with correct service grouping, hiding, and cud spread', async () => {
    const { registerVaultGeneratedTools } = await import('../src/tools/generated/vault.js');
    const { registry } = harness(FULL);
    registerVaultGeneratedTools(registry);
    const tools = registry.tools.filter((t) => !t.meta);
    expect(tools).toHaveLength(33);
    expect(tools.every((t) => t.service === 'vault')).toBe(true);
    expect(tools.every((t) => !registry.isVisible(t))).toBe(true);
    expect(tools.some((t) => t.cud === 'delete')).toBe(true);
    expect(tools.some((t) => t.cud === 'read')).toBe(true);
  });

  it('gates generated write tools through write-control policy', async () => {
    const { registerVaultGeneratedTools } = await import('../src/tools/generated/vault.js');
    const { registry, registered } = harness(READ_ONLY);
    registerVaultGeneratedTools(registry);
    const del = registry.tools.find((t) => t.cud === 'delete')!;
    const handler = registered.find((r) => r.name === del.name)!.handler;
    const res = await handler({ account: 'test' });
    expect(res.isError).toBe(true);
  });

  it('exposes every new optional bundle used by generated gates', async () => {
    const { OPTIONAL_SCOPE_BUNDLES } = await import('../src/auth.js');
    for (const bundle of ['classroom', 'cloudidentity', 'cloudsearch', 'vault', 'keep', 'driveactivity', 'drivelabels', 'script', 'postmaster', 'groupssettings', 'groupsmigration', 'licensing', 'reseller', 'appsmarket']) {
      expect(OPTIONAL_SCOPE_BUNDLES[bundle]?.length, bundle).toBeGreaterThan(0);
      for (const scope of OPTIONAL_SCOPE_BUNDLES[bundle]) {
        expect(scope, bundle).toMatch(/^https:\/\/www\.googleapis\.com\/auth\//);
      }
    }
  });

  it('fails loudly on name collisions', () => {
    const twisted = structuredClone(doc);
    twisted.resources.tasklists.methods.update2 = {
      ...twisted.resources.tasklists.methods.update,
      id: 'tasks.tasklists.UPDATE',
    };
    expect(() => planTools(twisted, api)).toThrow(/collision/);
  });
});
