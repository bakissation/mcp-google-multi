import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../src/registry.js';
import { registerDiscoverTools } from '../src/discover.js';
import type { Policy } from '../src/write-control.js';

const POLICY: Policy = { profile: 'safe-writes', readOnly: false, allow: [], deny: [] };

function setup() {
  const registered: { name: string; config: { description: string }; handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }[] = [];
  const server = {
    registerTool: (name: string, config: never, handler: never) => {
      registered.push({ name, config, handler });
      return 'ok';
    },
    sendToolListChanged: vi.fn(),
    server: { setRequestHandler: () => {} },
  };
  const registry = new ToolRegistry(server as never, POLICY);
  registry.registerTool('gmail_search', { description: 'Search messages', inputSchema: { account: z.string(), query: z.string() } }, () => {});
  registry.registerTool('gmail_send', { description: 'Send an email', inputSchema: { account: z.string(), to: z.string() } }, () => {});
  registry.registerTool('drive_search', { description: 'Search files', inputSchema: { account: z.string() } }, () => {});
  registerDiscoverTools(registry, POLICY);
  return { registry, registered, server };
}

describe('registerDiscoverTools', () => {
  it('registers one discover tool per service with the op vocabulary inline', () => {
    const { registered } = setup();
    const discoverNames = registered.filter((r) => r.name.endsWith('_discover')).map((r) => r.name);
    expect(discoverNames).toEqual(['gmail_discover', 'drive_discover']);
    const gmail = registered.find((r) => r.name === 'gmail_discover')!;
    expect(gmail.config.description).toContain('hidden');
    expect(gmail.config.description).toContain('search, send');
  });

  it('caps the description vocabulary: curated listed up to the cap, generated grouped (RQ2 token diet)', () => {
    const registered: { name: string; config: { description: string } }[] = [];
    const server = {
      registerTool: (name: string, config: never, handler: never) => {
        registered.push({ name, config });
        void handler;
        return 'ok';
      },
      sendToolListChanged: vi.fn(),
      server: { setRequestHandler: () => {} },
    };
    const registry = new ToolRegistry(server as never, POLICY);
    for (let i = 0; i < 15; i++) {
      registry.registerTool(`big_op${i}`, { description: 'x', inputSchema: { account: z.string() } }, () => {});
    }
    for (let i = 0; i < 30; i++) {
      registry.registerTool(
        `big_res${i % 5}_m${i}`,
        { description: 'x', inputSchema: { account: z.string() }, cud: 'read' } as never,
        () => {},
      );
    }
    registerDiscoverTools(registry, POLICY);
    const big = registered.find((r) => r.name === 'big_discover')!;
    // 15 curated ops, cap 10 shown; 30 generated ops compressed to groups.
    expect(big.config.description).toContain('+5 more');
    expect(big.config.description).toContain('30 generated ops:');
    expect(big.config.description).toContain('res0');
    expect(big.config.description).not.toContain('m29');
    expect(big.config.description.length).toBeLessThan(600);
  });

  it('discover returns the catalog, reveals the service, and notifies once', async () => {
    const { registry, registered, server } = setup();
    const gmail = registered.find((r) => r.name === 'gmail_discover')!;

    const result = await gmail.handler({ query: undefined });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.service).toBe('gmail');
    expect(payload.operations).toEqual([
      { tool: 'gmail_search', summary: 'Search messages', args: ['account', 'query'], cud: 'read' },
      { tool: 'gmail_send', summary: 'Send an email', args: ['account', 'to'], cud: 'create' },
    ]);
    expect(payload.writeControl).toContain('profile=safe-writes');
    expect(server.sendToolListChanged).toHaveBeenCalledTimes(1);
    expect(registry.isVisible(registry.tools.find((t) => t.name === 'gmail_search')!)).toBe(true);
    expect(registry.isVisible(registry.tools.find((t) => t.name === 'drive_search')!)).toBe(false);

    await gmail.handler({ query: undefined });
    expect(server.sendToolListChanged).toHaveBeenCalledTimes(1);
  });

  it('discover filters by query and hints when nothing matches', async () => {
    const { registered } = setup();
    const gmail = registered.find((r) => r.name === 'gmail_discover')!;

    const filtered = JSON.parse((await gmail.handler({ query: 'send' })).content[0].text);
    expect(filtered.operations.map((o: { tool: string }) => o.tool)).toEqual(['gmail_send']);

    const empty = JSON.parse((await gmail.handler({ query: 'zzz' })).content[0].text);
    expect(empty.operations).toEqual([]);
    expect(empty.next).toContain('without query');
  });
});
