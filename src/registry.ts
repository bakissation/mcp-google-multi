import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Policy, isAllowed, writeDisabledResult } from './write-control.js';

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

  constructor(server: McpServer, policy: Policy) {
    this.registerTool = ((name: string, config: unknown, handler: (...a: unknown[]) => unknown) => {
      const service = name.includes('_') ? name.slice(0, name.indexOf('_')) : name;
      const cud = inferCud(name);
      this.tools.push({ name, service, cud });
      const guarded =
        cud === 'read'
          ? handler
          : (...args: unknown[]) =>
              isAllowed({ name, service, cud }, policy)
                ? handler(...args)
                : writeDisabledResult({ name, service, cud }, policy);
      return (server.registerTool as (...a: unknown[]) => unknown)(name, config, guarded);
    }) as McpServer['registerTool'];
  }
}
