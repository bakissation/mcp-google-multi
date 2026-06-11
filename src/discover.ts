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
  for (const service of registry.services()) {
    registry.registerMeta(
      `${service}_discover`,
      {
        description:
          `List the available ${service} operations. Operational ${service} tools are hidden ` +
          `until discovered — call this first, then call the tool you need by name. ` +
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
