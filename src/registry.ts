import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export type Cud = 'read' | 'create' | 'update' | 'delete';

export interface ToolEntry {
  name: string;
  service: string;
  cud: Cud;
}

const CUD_OVERRIDES: Record<string, Cud> = {
  drive_untrash: 'update',
};

const DELETE_VERB = /(^|_)(delete|remove|trash|clear|empty)(_|$)/;
const CREATE_VERB = /(^|_)(create|add|insert|send|upload|copy|import|append|submit|duplicate|share|quick)(_|$)/;
const UPDATE_VERB = /(^|_)(update|patch|modify|set|move|write|format|merge|unmerge|sort|replace|resize|publish|resolve)(_|$)/;

export function inferCud(name: string): Cud {
  const override = CUD_OVERRIDES[name];
  if (override) return override;
  if (DELETE_VERB.test(name)) return 'delete';
  if (CREATE_VERB.test(name)) return 'create';
  if (UPDATE_VERB.test(name)) return 'update';
  return 'read';
}

export class ToolRegistry {
  readonly tools: ToolEntry[] = [];
  readonly registerTool: McpServer['registerTool'];

  constructor(server: McpServer) {
    this.registerTool = ((name: string, ...rest: unknown[]) => {
      const service = name.includes('_') ? name.slice(0, name.indexOf('_')) : name;
      this.tools.push({ name, service, cud: inferCud(name) });
      return (server.registerTool as (...args: unknown[]) => unknown)(name, ...rest);
    }) as McpServer['registerTool'];
  }
}
