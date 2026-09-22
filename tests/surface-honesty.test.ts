import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '../src/registry.js';
import { SERVICES, unknownToolMessage } from '../src/services.js';
import { GENERATED_SERVICES } from '../src/tools/generated/index.js';
import type { Policy } from '../src/write-control.js';

const POLICY: Policy = { profile: 'read-only', readOnly: true, allow: [], deny: [] };

function stub() {
  return { registerTool: () => 'ok', sendToolListChanged: vi.fn(), server: { setRequestHandler: () => {} } };
}

function buildAll(mode: 'lazy' | 'curated' | 'eager' = 'eager') {
  const registry = new ToolRegistry(stub() as never, POLICY, mode);
  for (const s of SERVICES) s.register(registry);
  for (const g of GENERATED_SERVICES) g.register(registry);
  return registry;
}

describe('tools that no bundle can authorize', () => {
  const registry = buildAll();
  const ungrantable = registry.tools.filter((t) => registry.isUngrantable(t));

  it('is a static property of the bundle catalog, not of an account', () => {
    // Discovery scope lists are ANY-OF, so one grantable alternative is enough.
    // A tool with no declared scopes is never judged unreachable.
    expect(ungrantable.every((t) => (t.requiredScopes?.length ?? 0) > 0)).toBe(true);
    expect(ungrantable.length).toBeGreaterThan(100);
  });

  it('hides them from tools/list even in eager mode', () => {
    expect(ungrantable.some((t) => registry.isVisible(t))).toBe(false);
  });

  it('keeps them registered, so a call by name still reaches the real scope error', () => {
    for (const t of ungrantable.slice(0, 20)) expect(registry.hasTool(t.name)).toBe(true);
  });

  it('still lists them in the service catalog, marked', () => {
    const rows = registry.catalog('admin');
    const marked = rows.filter((r) => r.unreachable);
    expect(marked.length).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(marked.length);
    for (const r of marked) expect(registry.hasTool(r.tool)).toBe(true);
  });

  it('never hides a curated tool: those authorize at service grain', () => {
    expect(ungrantable.some((t) => !t.generated)).toBe(false);
  });
});

describe('unknown tool name', () => {
  const registry = buildAll();

  it('offers a did-you-mean for a near miss', () => {
    expect(unknownToolMessage(registry, 'gmail_serach')).toMatch(/Did you mean: .*gmail_search/);
  });

  it('names the scope bundle when the service exists but is gated', () => {
    const gated = new ToolRegistry(stub() as never, POLICY, 'eager');
    SERVICES.find((s) => s.name === 'gmail')!.register(gated);
    const msg = unknownToolMessage(gated, 'keep_notes_zzz');
    expect(msg).toContain('"keep" service is not enabled');
    expect(msg).toContain('google_api_call');
  });

  it('points at discovery when the name resembles nothing at all', () => {
    const msg = unknownToolMessage(registry, 'zzzz_totally_made_up_xyzzy');
    expect(msg).toContain('_discover');
    expect(msg).toContain('google_api_search');
  });
});

describe('diagnose', () => {
  it('is advertised at idle: the README sends people here when stuck', () => {
    const registry = new ToolRegistry(stub() as never, POLICY, 'lazy');
    SERVICES.find((s) => s.name === 'gmail')!.register(registry);
    registry.registerMeta('diagnose', { description: 'health report', inputSchema: {} }, () => ({ content: [] }));
    const entry = registry.tools.find((t) => t.name === 'diagnose')!;
    expect(entry.meta).toBe(true);
    expect(registry.isVisible(entry)).toBe(true);
  });
});
