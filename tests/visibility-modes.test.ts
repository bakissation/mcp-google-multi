import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, resolveDiscoveryMode, type DiscoveryMode } from '../src/registry.js';
import { registerDiscoverTools } from '../src/discover.js';
import type { Policy } from '../src/write-control.js';

const POLICY: Policy = { profile: 'safe-writes', readOnly: false, allow: [], deny: [] };

function setup(mode?: DiscoveryMode) {
  const server = {
    registerTool: () => 'ok',
    sendToolListChanged: vi.fn(),
    server: { setRequestHandler: () => {} },
  };
  const registry = new ToolRegistry(server as never, POLICY, mode);
  registry.registerTool('gmail_search', { description: 'curated', inputSchema: { account: z.string() } }, () => {});
  registry.registerTool(
    'gmail_labels_get',
    { description: 'generated', inputSchema: { account: z.string() }, cud: 'read' } as never,
    () => {},
  );
  registry.registerMeta('account_list', { description: 'meta', inputSchema: {} }, () => {});
  const visible = () => registry.tools.filter((t) => registry.isVisible(t)).map((t) => t.name);
  return { registry, server, visible };
}

describe('resolveDiscoveryMode', () => {
  it('defaults to lazy; warns and falls back on a typo', () => {
    expect(resolveDiscoveryMode({} as NodeJS.ProcessEnv)).toBe('lazy');
    expect(resolveDiscoveryMode({ GOOGLE_DISCOVERY: 'curated' } as NodeJS.ProcessEnv)).toBe('curated');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(resolveDiscoveryMode({ GOOGLE_DISCOVERY: 'eagre' } as NodeJS.ProcessEnv)).toBe('lazy');
    expect(String(stderr.mock.calls[0]?.[0])).toContain('eagre');
    stderr.mockRestore();
  });
});

describe('visibility modes (layer x mode)', () => {
  it('lazy: meta only until a reveal — exact v5 behavior', () => {
    const { registry, visible } = setup('lazy');
    expect(visible()).toEqual(['account_list']);
    registry.reveal('gmail');
    expect(visible().sort()).toEqual(['account_list', 'gmail_labels_get', 'gmail_search']);
  });

  it('curated: curated tools advertised, generated stay hidden', () => {
    const { visible } = setup('curated');
    expect(visible().sort()).toEqual(['account_list', 'gmail_search']);
  });

  it('curated + reveal(service): the revealed disjunct exposes that service\'s generated tools (spec formula parity)', () => {
    const { registry, visible } = setup('curated');
    registry.reveal('gmail');
    expect(visible().sort()).toEqual(['account_list', 'gmail_labels_get', 'gmail_search']);
  });

  it('eager: everything advertised', () => {
    const { visible } = setup('eager');
    expect(visible().sort()).toEqual(['account_list', 'gmail_labels_get', 'gmail_search']);
  });

  it('generated provenance comes from the explicit cud marker', () => {
    const { registry } = setup('lazy');
    const byName = Object.fromEntries(registry.tools.map((t) => [t.name, t.generated]));
    expect(byName.gmail_search).toBe(false);
    expect(byName.gmail_labels_get).toBe(true);
    expect(byName.account_list).toBe(false);
  });
});

describe('A11: anthropic/* keys ride _meta, never annotations (SDK strips unknown annotation keys)', () => {
  it('toToolJson emits _meta for client extension keys and keeps annotations spec-only', () => {
    const server = { registerTool: () => 'ok', sendToolListChanged: vi.fn(), server: { setRequestHandler: () => {} } };
    const registry = new ToolRegistry(server as never, POLICY, 'lazy');
    (registry.registerTool as unknown as (n: string, c: Record<string, unknown>, h: () => unknown) => void)(
      'gmail_probe',
      { description: 'x', inputSchema: { account: z.string().optional() }, _meta: { 'anthropic/maxResultSizeChars': 50_000 } },
      () => {},
    );
    const entry = registry.tools.find((t) => t.name === 'gmail_probe')!;
    expect(entry.clientMeta).toEqual({ 'anthropic/maxResultSizeChars': 50_000 });
    expect(Object.keys(entry.annotations).some((k) => k.startsWith('anthropic/'))).toBe(false);
    // wire shape via the list handler path
    let listed: { tools: { name: string; _meta?: Record<string, unknown>; annotations: Record<string, unknown> }[] } | null = null;
    const server2 = {
      registerTool: () => 'ok',
      sendToolListChanged: vi.fn(),
      server: { setRequestHandler: (_s: never, h: () => Promise<never>) => { listed = h as never; } },
    };
    const reg2 = new ToolRegistry(server2 as never, POLICY, 'eager');
    (reg2.registerTool as unknown as (n: string, c: Record<string, unknown>, h: () => unknown) => void)(
      'gmail_probe2',
      { description: 'x', inputSchema: {}, _meta: { 'anthropic/alwaysLoad': true } },
      () => {},
    );
    reg2.installListHandler();
    return (listed as unknown as () => Promise<{ tools: { name: string; _meta?: Record<string, unknown>; annotations: Record<string, unknown> }[] }>)().then((r) => {
      const t = r.tools.find((x) => x.name === 'gmail_probe2')!;
      expect(t._meta).toEqual({ 'anthropic/alwaysLoad': true });
      expect(Object.keys(t.annotations).some((k) => k.startsWith('anthropic/'))).toBe(false);
    });
  });
});

describe('expand/collapse runtime overlay', () => {
  it('expand lifts lazy to curated and fires list_changed; collapse drops back and clears reveals', () => {
    const { registry, server, visible } = setup('lazy');
    expect(registry.expand()).toBe(true);
    expect(server.sendToolListChanged).toHaveBeenCalledTimes(1);
    expect(visible().sort()).toEqual(['account_list', 'gmail_search']);

    registry.reveal('gmail'); // widen further
    expect(visible().sort()).toEqual(['account_list', 'gmail_labels_get', 'gmail_search']);

    expect(registry.collapse()).toBe(true);
    expect(visible()).toEqual(['account_list']);
  });

  it('expand is a no-op when the configured mode already advertises curated', () => {
    const { registry, server } = setup('curated');
    expect(registry.expand()).toBe(false);
    expect(server.sendToolListChanged).not.toHaveBeenCalled();
  });

  it('collapse with nothing expanded or revealed is a no-op', () => {
    const { registry, server } = setup('lazy');
    expect(registry.collapse()).toBe(false);
    expect(server.sendToolListChanged).not.toHaveBeenCalled();
  });

  it('discover_all / discover_reset meta-tools are always visible and drive the overlay', async () => {
    const server = {
      registerTool: () => 'ok',
      sendToolListChanged: vi.fn(),
      server: { setRequestHandler: () => {} },
    };
    const registry = new ToolRegistry(server as never, POLICY, 'lazy');
    registry.registerTool('gmail_search', { description: 'curated', inputSchema: { account: z.string() } }, () => {});
    registerDiscoverTools(registry, POLICY);
    const names = registry.tools.filter((t) => t.meta).map((t) => t.name);
    expect(names).toContain('discover_all');
    expect(names).toContain('discover_reset');
  });
});
