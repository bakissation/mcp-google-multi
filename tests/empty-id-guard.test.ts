import { describe, it, expect, vi } from 'vitest';
import type { ZodType } from 'zod';
import { ToolRegistry } from '../src/registry.js';
import { SERVICES } from '../src/services.js';
import { GENERATED_SERVICES } from '../src/tools/generated/index.js';
import type { Policy } from '../src/write-control.js';

const POLICY: Policy = { profile: 'read-only', readOnly: true, allow: [], deny: [] };

// A value that lands in the URL path is a path SEGMENT. An empty one collapses
// it, so the request addresses the collection and a `get` silently answers with
// a LIST (searchconsole_sites_get with siteUrl:"" returned the whole site list
// as success). Display names are excluded on purpose: an empty folder or label
// name is a plain user error, not a different request.
const IDENTIFIER = /(Id|Key|Url|Path)$/;
const EXTRA_IDENTIFIERS = new Set(['resourceName', 'groupResourceName']);

function buildAll() {
  const server = {
    registerTool: () => 'ok',
    sendToolListChanged: vi.fn(),
    server: { setRequestHandler: () => {} },
  };
  const registry = new ToolRegistry(server as never, POLICY, 'eager');
  for (const s of SERVICES) s.register(registry);
  for (const g of GENERATED_SERVICES) g.register(registry);
  return registry;
}

describe('required identifier arguments reject the empty string', () => {
  const registry = buildAll();

  const targets = registry.tools.flatMap((tool) =>
    Object.entries(tool.inputShape ?? {})
      .filter(([field]) => IDENTIFIER.test(field) || EXTRA_IDENTIFIERS.has(field))
      .map(([field, schema]) => ({ tool: tool.name, field, schema: schema as ZodType })),
  );

  it('covers the whole surface, not a sample', () => {
    expect(targets.length).toBeGreaterThan(500);
  });

  it.each([
    ['searchconsole_sites_get', 'siteUrl'],
    ['calendar_get_event', 'eventId'],
    ['gmail_get_draft', 'draftId'],
    ['gmail_read_thread', 'threadId'],
    ['gmail_read', 'messageId'],
    ['admin_users_get', 'userKey'],
    ['drive_read', 'fileId'],
    ['sheets_get', 'spreadsheetId'],
  ])('%s.%s', (toolName, field) => {
    const entry = targets.find((t) => t.tool === toolName && t.field === field);
    expect(entry, `${toolName}.${field} not registered`).toBeDefined();
    expect(entry!.schema.safeParse('').success).toBe(false);
  });

  it('no REQUIRED identifier anywhere accepts an empty string', () => {
    const offenders = targets
      .filter(({ schema }) => schema.safeParse(undefined).success === false)
      .filter(({ schema }) => schema.safeParse('').success)
      .map(({ tool, field }) => `${tool}.${field}`);
    expect(offenders).toEqual([]);
  });
});
