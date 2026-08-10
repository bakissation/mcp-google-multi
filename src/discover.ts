import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import { describePolicy, type Policy } from './write-control.js';

function opVocabulary(registry: ToolRegistry, service: string): string {
  const ops = registry.catalog(service).map((o) =>
    o.tool.startsWith(`${service}_`) ? o.tool.slice(service.length + 1) : o.tool,
  );
  return [...new Set(ops)].join(', ');
}

export function registerDiscoverTools(registry: ToolRegistry, policy: Policy): void {
  // Agent-controllable runtime expansion (D3 refinement): reveal the whole
  // curated quality layer for heavy Google work, collapse to reclaim the
  // name/schema context budget after. stdio-only semantics — over stateless
  // HTTP the mode is forced curated and these are no-ops.
  registry.registerMeta(
    'discover_all',
    {
      description:
        'Reveal ALL curated Google tools at once (instead of per-service discovery). ' +
        'Use when starting substantial Google work so the shaped, high-quality tools are ' +
        'directly callable; prefer them over google_api_call. Pair with discover_reset when done.',
      inputSchema: {},
    },
    async () => {
      const changed = registry.expand();
      const counts = registry.visibleCount();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              expanded: changed,
              visibleTools: counts.eager + counts.revealed,
              note: changed
                ? 'Curated tools are now advertised. Generated long-tail tools still appear per-service via {service}_discover.'
                : 'Surface was already expanded (or the configured mode already advertises curated tools).',
            }),
          },
        ],
      };
    },
  );

  registry.registerMeta(
    'discover_reset',
    {
      description:
        'Collapse the tool surface back to the configured default (lean meta-tools-only under the ' +
        'default lazy mode), reclaiming context budget after heavy Google work. All tools remain ' +
        'callable by name after collapsing.',
      inputSchema: {},
    },
    async () => {
      const changed = registry.collapse();
      const counts = registry.visibleCount();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              collapsed: changed,
              visibleTools: counts.eager + counts.revealed,
              note: 'Hidden tools stay callable by name (graceful dispatch); re-expand any time with discover_all.',
            }),
          },
        ],
      };
    },
  );

  for (const service of registry.services()) {
    registry.registerMeta(
      `${service}_discover`,
      {
        description:
          `List the available ${service} operations. ` +
          (registry.mode === 'lazy'
            ? `Operational ${service} tools are hidden until discovered — call this first, then call the tool you need by name. `
            : `Returns the ${service} catalog (and reveals any still-hidden ${service} tools). `) +
          `Operations: ${opVocabulary(registry, service)}.`,
        inputSchema: {
          query: z.string().optional().describe('Keyword to filter the returned operations'),
        },
      },
      async ({ query }) => {
        const operations = registry.catalog(service, query as string | undefined);
        registry.reveal(service);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                service,
                operations,
                writeControl: describePolicy(policy),
                next:
                  operations.length > 0
                    ? 'Call the chosen tool by name; it is now listed and callable.'
                    : `No ${service} operation matches "${query}". Call again without query for the full catalog.`,
              }),
            },
          ],
        };
      },
    );
  }
}
