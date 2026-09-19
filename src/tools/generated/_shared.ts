import { z } from 'zod';
import { accountAliasSchema } from '../../accounts.js';
import { executeApiMethod, type ApiMethodRef, type ExecuteDeps, type QueryParams } from '../../executor.js';
import type { Cud, ToolRegistry } from '../../registry.js';

export interface GeneratedParam {
  field: string;
  // Discovery parameter name when it had to be renamed to avoid clashing with
  // the reserved account/body fields; equals `field` otherwise.
  api: string;
  location: 'path' | 'query';
}

export interface GeneratedToolDef {
  name: string;
  cud: Cud;
  description: string;
  method: ApiMethodRef;
  params: GeneratedParam[];
  hasBody: boolean;
  /** Typed-body tier: these top-level args assemble into the request body
   * (flat schemas only; deep schemas keep the single opaque `body` arg). */
  bodyParams?: Array<{ field: string; api: string }>;
  shape: z.ZodRawShape;
}

export function accountField() {
  return accountAliasSchema.optional().describe('Google account alias (omit for the default account)');
}

interface GeneratedToolConfig {
  description: string;
  inputSchema: z.ZodRawShape;
  cud: Cud;
  annotations: Record<string, unknown>;
  requiredScopes?: readonly string[];
}

export function registerGeneratedTool(registry: ToolRegistry, def: GeneratedToolDef, deps: ExecuteDeps = {}): void {
  // Widened locally: `cud` is a registry extension the SDK config type doesn't
  // carry; the registry reads it before handing the config to the SDK.
  const register = registry.registerTool as (name: string, config: GeneratedToolConfig, handler: (args: Record<string, unknown>) => unknown) => void;
  register(
    def.name,
    {
      description: def.description,
      inputSchema: def.shape,
      cud: def.cud,
      annotations: { openWorldHint: true },
      requiredScopes: def.method.scopes,
    },
    async (args: Record<string, unknown>) => {
      const pathParams: Record<string, string | number> = {};
      const queryParams: QueryParams = {};
      for (const p of def.params) {
        const value = args[p.field];
        if (value === undefined) continue;
        if (p.location === 'path') pathParams[p.api] = value as string | number;
        else queryParams[p.api] = value as QueryParams[string];
      }
      let body: unknown = def.hasBody ? args.body : undefined;
      if (def.bodyParams) {
        const assembled: Record<string, unknown> = {};
        for (const bp of def.bodyParams) {
          const value = args[bp.field];
          if (value !== undefined) assembled[bp.api] = value;
        }
        body = assembled;
      }
      return executeApiMethod(
        def.method,
        {
          account: args.account as string,
          pathParams,
          queryParams,
          body,
        },
        deps,
      );
    },
  );
}
