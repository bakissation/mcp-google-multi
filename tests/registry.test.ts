import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { inferCud, ToolRegistry } from '../src/registry.js';
import type { Policy } from '../src/write-control.js';

describe('inferCud', () => {
  const cases: [string, string][] = [
    ['gmail_list_labels', 'read'],
    ['gmail_get_profile', 'read'],
    ['gmail_read_thread', 'read'],
    ['drive_search', 'read'],
    ['sheets_batch_read', 'read'],
    ['searchconsole_url_inspect', 'read'],
    ['searchconsole_searchanalytics_query', 'read'],
    ['contacts_group_members', 'read'],
    ['drive_get_about', 'read'],
    ['gmail_send', 'create'],
    ['gmail_create_draft', 'create'],
    ['drive_upload', 'create'],
    ['drive_copy', 'create'],
    ['drive_share', 'create'],
    ['calendar_quick_add', 'create'],
    ['sheets_append_rows', 'create'],
    ['searchconsole_sites_add', 'create'],
    ['docs_insert_text', 'create'],
    ['gmail_modify_labels', 'update'],
    ['gmail_batch_modify', 'update'],
    ['drive_move', 'update'],
    ['drive_update', 'update'],
    ['drive_permission_update', 'update'],
    ['sheets_write_range', 'update'],
    ['sheets_batch_write', 'update'],
    ['gmail_set_vacation', 'update'],
    ['drive_access_proposal_resolve', 'update'],
    ['drive_untrash', 'update'],
    ['gmail_delete', 'delete'],
    ['gmail_batch_delete', 'delete'],
    ['drive_trash', 'delete'],
    ['drive_remove_permission', 'delete'],
    ['drive_empty_trash', 'delete'],
    ['sheets_clear_range', 'delete'],
    ['tasks_clear', 'delete'],
    ['docs_delete_named_range', 'delete'],
  ];
  it.each(cases)('%s → %s', (name, expected) => {
    expect(inferCud(name)).toBe(expected);
  });

  it('does not confuse "shared" with the "share" verb', () => {
    expect(inferCud('drive_shared_drives_list')).toBe('read');
    expect(inferCud('drive_share')).toBe('create');
  });
});

const FULL_WRITES: Policy = { profile: 'full-writes', readOnly: false, allow: [], deny: [] };

function fakeServer() {
  const registered: { name: string; config: Record<string, unknown>; handler: (...a: unknown[]) => unknown }[] = [];
  let listHandler: (() => Promise<{ tools: unknown[] }>) | undefined;
  const server = {
    registerTool: (name: string, config: Record<string, unknown>, handler: (...a: unknown[]) => unknown) => {
      registered.push({ name, config, handler });
      return 'ok';
    },
    sendToolListChanged: vi.fn(),
    server: {
      setRequestHandler: (_schema: unknown, handler: () => Promise<{ tools: unknown[] }>) => {
        listHandler = handler;
      },
    },
  };
  return { server, registered, getListHandler: () => listHandler };
}

describe('ToolRegistry', () => {
  it('records the tool entry and forwards to the server', () => {
    const { server, registered } = fakeServer();
    const reg = new ToolRegistry(server as never, FULL_WRITES);
    const ret = reg.registerTool('gmail_send', { description: 'x', inputSchema: { to: z.string() } }, () => {});
    expect(ret).toBe('ok');
    expect(registered).toHaveLength(1);
    expect(registered[0].name).toBe('gmail_send');
    expect(reg.tools).toMatchObject([
      { name: 'gmail_send', service: 'gmail', cud: 'create', description: 'x', meta: false },
    ]);
  });

  it('computes annotations per cud class on both the registration and list paths', async () => {
    const { server, registered, getListHandler } = fakeServer();
    const reg = new ToolRegistry(server as never, FULL_WRITES);
    reg.registerTool('gmail_search', { description: 'x' }, () => {});
    reg.registerTool('gmail_create_draft', { description: 'x' }, () => {});
    reg.registerTool('gmail_modify_labels', { description: 'x' }, () => {});
    reg.registerTool('gmail_delete', { description: 'x' }, () => {});
    const expected: Record<string, { readOnlyHint: boolean; destructiveHint: boolean }> = {
      gmail_search: { readOnlyHint: true, destructiveHint: false },
      gmail_create_draft: { readOnlyHint: false, destructiveHint: false },
      gmail_modify_labels: { readOnlyHint: false, destructiveHint: true },
      gmail_delete: { readOnlyHint: false, destructiveHint: true },
    };
    for (const r of registered) {
      expect(r.config.annotations, r.name).toMatchObject(expected[r.name]);
    }
    reg.installListHandler();
    reg.reveal('gmail');
    const listed = (await getListHandler()!()).tools as { name: string; annotations: Record<string, unknown> }[];
    for (const t of listed) {
      expect(t.annotations, t.name).toMatchObject(expected[t.name]);
    }
  });

  it('explicit annotation overrides survive through to the list handler', async () => {
    const { server, registered, getListHandler } = fakeServer();
    const reg = new ToolRegistry(server as never, FULL_WRITES);
    reg.registerTool('gmail_search', { description: 'x', annotations: { readOnlyHint: false, idempotentHint: true } }, () => {});
    reg.installListHandler();
    reg.reveal('gmail');
    expect(registered[0].config.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
    const listed = (await getListHandler()!()).tools as { annotations: Record<string, unknown> }[];
    expect(listed[0].annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
  });

  it('maps service overrides so admin reporting stays under the admin service', () => {
    const { server } = fakeServer();
    const reg = new ToolRegistry(server as never, FULL_WRITES);
    reg.registerTool('reports_activities_list', { description: 'x' }, () => {});
    reg.registerTool('admin_users_list', { description: 'x' }, () => {});
    expect(reg.services()).toEqual(['admin']);
    expect(reg.catalog('admin').map((o) => o.tool)).toEqual(['reports_activities_list', 'admin_users_list']);
  });

  it('registerMeta marks the entry as meta and skips the catalog', () => {
    const { server } = fakeServer();
    const reg = new ToolRegistry(server as never, FULL_WRITES);
    reg.registerMeta('gmail_discover', { description: 'meta' }, () => {});
    reg.registerTool('gmail_search', { description: 'op' }, () => {});
    expect(reg.tools[0].meta).toBe(true);
    expect(reg.services()).toEqual(['gmail']);
    expect(reg.catalog('gmail').map((o) => o.tool)).toEqual(['gmail_search']);
  });

  it('catalog returns summary/args/cud and filters by query', () => {
    const { server } = fakeServer();
    const reg = new ToolRegistry(server as never, FULL_WRITES);
    reg.registerTool(
      'drive_upload',
      { description: 'Upload a file to Drive', inputSchema: { account: z.string(), path: z.string() } },
      () => {},
    );
    reg.registerTool('drive_search', { description: 'Search files', inputSchema: { account: z.string() } }, () => {});
    expect(reg.catalog('drive')).toEqual([
      { tool: 'drive_upload', summary: 'Upload a file to Drive', args: ['account', 'path'], cud: 'create' },
      { tool: 'drive_search', summary: 'Search files', args: ['account'], cud: 'read' },
    ]);
    expect(reg.catalog('drive', 'upload').map((o) => o.tool)).toEqual(['drive_upload']);
    expect(reg.catalog('drive', 'nothing-matches')).toEqual([]);
  });

  it('reveal notifies once per service and flips visibility', () => {
    const { server } = fakeServer();
    const reg = new ToolRegistry(server as never, FULL_WRITES);
    reg.registerTool('drive_search', { description: 'x' }, () => {});
    const entry = reg.tools[0];
    expect(reg.isVisible(entry)).toBe(false);
    expect(reg.reveal('drive')).toBe(true);
    expect(reg.reveal('drive')).toBe(false);
    expect(reg.isVisible(entry)).toBe(true);
    expect(server.sendToolListChanged).toHaveBeenCalledTimes(1);
  });

  it('list handler exposes meta tools at boot, operational tools after reveal', async () => {
    const { server, getListHandler } = fakeServer();
    const reg = new ToolRegistry(server as never, FULL_WRITES);
    reg.registerTool('drive_search', { description: 'Search files', inputSchema: { account: z.string() } }, () => {});
    reg.registerMeta('drive_discover', { description: 'meta', inputSchema: { query: z.string().optional() } }, () => {});
    reg.installListHandler();
    const handler = getListHandler();
    expect(handler).toBeDefined();

    const before = await handler!();
    expect(before.tools.map((t) => (t as { name: string }).name)).toEqual(['drive_discover']);

    reg.reveal('drive');
    const after = await handler!();
    expect(after.tools.map((t) => (t as { name: string }).name)).toEqual(['drive_search', 'drive_discover']);

    const search = after.tools.find((t) => (t as { name: string }).name === 'drive_search') as {
      inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] };
      annotations: Record<string, boolean>;
    };
    expect(search.inputSchema.type).toBe('object');
    expect(Object.keys(search.inputSchema.properties)).toEqual(['account']);
    expect(search.inputSchema.required).toEqual(['account']);
    expect(search.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });

    const schemaOf = (r: { tools: unknown[] }, name: string) =>
      (r.tools.find((t) => (t as { name: string }).name === name) as { inputSchema: unknown }).inputSchema;
    expect(schemaOf(after, 'drive_discover')).toBe(schemaOf(before, 'drive_discover'));
  });

  it('installListHandler throws when nothing is registered', () => {
    const { server } = fakeServer();
    const reg = new ToolRegistry(server as never, FULL_WRITES);
    expect(() => reg.installListHandler()).toThrow(/at least one registered tool/);
  });

  it('visibleCount tracks eager/revealed/hidden', () => {
    const { server } = fakeServer();
    const reg = new ToolRegistry(server as never, FULL_WRITES);
    reg.registerTool('drive_search', { description: 'x' }, () => {});
    reg.registerTool('gmail_search', { description: 'x' }, () => {});
    reg.registerMeta('drive_discover', { description: 'meta' }, () => {});
    expect(reg.visibleCount()).toEqual({ eager: 1, revealed: 0, hidden: 2 });
    reg.reveal('drive');
    expect(reg.visibleCount()).toEqual({ eager: 1, revealed: 1, hidden: 1 });
  });
});
