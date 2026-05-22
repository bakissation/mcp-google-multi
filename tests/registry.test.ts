import { describe, it, expect } from 'vitest';
import { inferCud, ToolRegistry } from '../src/registry.js';

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

describe('ToolRegistry', () => {
  it('records name/service/cud and forwards to the server', () => {
    const calls: unknown[][] = [];
    const fakeServer = {
      registerTool: (...a: unknown[]) => { calls.push(a); return 'ok'; },
    } as never;
    const reg = new ToolRegistry(fakeServer, { profile: 'full-writes', readOnly: false, allow: [], deny: [] });
    const ret = reg.registerTool('gmail_send', { description: 'x' }, () => {});
    expect(ret).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('gmail_send');
    expect(reg.tools).toEqual([{ name: 'gmail_send', service: 'gmail', cud: 'create' }]);
  });
});
