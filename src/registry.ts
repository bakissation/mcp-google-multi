import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type Policy, isAllowed, writeDisabledResult } from './write-control.js';
import { compactResult, trimEnabled } from './trim.js';
import { fanoutAccountField, invalidAccountsResult, parseAccountSelector, runFanout } from './fanout.js';

export type Cud = 'read' | 'create' | 'update' | 'delete';

export interface ToolEntry {
  name: string;
  service: string;
  cud: Cud;
  description: string;
  inputShape: z.ZodRawShape;
  annotations: Record<string, unknown>;
  meta: boolean;
}

export interface CatalogOperation {
  tool: string;
  summary: string;
  args: string[];
  cud: Cud;
}

interface ToolConfig {
  description?: string;
  inputSchema?: z.ZodRawShape;
  annotations?: Record<string, unknown>;
}

const CUD_OVERRIDES: Record<string, Cud> = {
  drive_untrash: 'update',
  drive_transfer: 'create',
};

const SERVICE_OVERRIDES: Record<string, string> = {
  reports_activities_list: 'admin',
};

// read tools that write local files — same savePath fanned across accounts would clobber
const FANOUT_EXCLUDE = new Set(['gmail_download_attachment', 'drive_download', 'drive_export']);

function isAccountEnum(field: unknown): boolean {
  return (field as { _zod?: { def?: { type?: string } } } | undefined)?._zod?.def?.type === 'enum';
}

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
  readonly policy: Policy;
  readonly registerTool: McpServer['registerTool'];
  private readonly revealed = new Set<string>();
  private readonly jsonSchemaCache = new Map<string, unknown>();
  private readonly compactOutput = trimEnabled();
  private registeringMeta = false;

  constructor(
    private readonly server: McpServer,
    policy: Policy,
  ) {
    this.policy = policy;
    this.registerTool = ((name: string, config: ToolConfig, handler: (...a: unknown[]) => unknown) => {
      const service =
        SERVICE_OVERRIDES[name] ?? (name.includes('_') ? name.slice(0, name.indexOf('_')) : name);
      const cud = inferCud(name);
      // destructiveHint=false claims "additive only" (MCP spec) — updates overwrite, so they stay true.
      const annotations = {
        readOnlyHint: cud === 'read',
        destructiveHint: cud === 'delete' || cud === 'update',
        ...config.annotations,
      };

      // never fan out meta tools: google_api_call infers cud=read but executes writes
      let inputShape = config.inputSchema ?? {};
      let baseHandler = handler;
      if (cud === 'read' && !this.registeringMeta && !FANOUT_EXCLUDE.has(name) && isAccountEnum(inputShape.account)) {
        const description = (inputShape.account as z.ZodType).description ?? 'Google account alias';
        inputShape = { ...inputShape, account: fanoutAccountField(description) };
        baseHandler = async (...args: unknown[]) => {
          const first = args[0] as { account?: string } | undefined;
          const parsed = parseAccountSelector(typeof first?.account === 'string' ? first.account : '');
          if (!parsed.ok) return invalidAccountsResult(parsed.invalid);
          if (!parsed.fanout) return handler({ ...first, account: parsed.aliases[0] }, ...args.slice(1));
          return runFanout(handler, args, parsed.aliases);
        };
      }

      this.tools.push({
        name,
        service,
        cud,
        description: config.description ?? '',
        inputShape,
        annotations,
        meta: this.registeringMeta,
      });
      const guarded =
        cud === 'read'
          ? baseHandler
          : (...args: unknown[]) =>
              isAllowed({ name, service, cud }, policy)
                ? baseHandler(...args)
                : writeDisabledResult({ name, service, cud }, policy);
      const finalHandler = this.compactOutput
        ? async (...args: unknown[]) => compactResult(await (guarded(...args) as Promise<Parameters<typeof compactResult>[0]>))
        : guarded;
      return (server.registerTool as (...a: unknown[]) => unknown)(name, { ...config, inputSchema: inputShape, annotations }, finalHandler);
    }) as McpServer['registerTool'];
  }

  registerMeta: McpServer['registerTool'] = ((name: string, config: unknown, handler: unknown) => {
    this.registeringMeta = true;
    try {
      return (this.registerTool as (...a: unknown[]) => unknown)(name, config, handler);
    } finally {
      this.registeringMeta = false;
    }
  }) as McpServer['registerTool'];

  services(): string[] {
    return [...new Set(this.tools.filter((t) => !t.meta).map((t) => t.service))];
  }

  catalog(service: string, query?: string): CatalogOperation[] {
    const q = query?.trim().toLowerCase();
    return this.tools
      .filter((t) => !t.meta && t.service === service)
      .filter((t) => !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
      .map((t) => ({
        tool: t.name,
        summary: t.description,
        args: Object.keys(t.inputShape),
        cud: t.cud,
      }));
  }

  reveal(service: string): boolean {
    if (this.revealed.has(service)) return false;
    this.revealed.add(service);
    this.server.sendToolListChanged();
    return true;
  }

  isVisible(tool: ToolEntry): boolean {
    return tool.meta || this.revealed.has(tool.service);
  }

  visibleCount(): { eager: number; revealed: number; hidden: number } {
    const meta = this.tools.filter((t) => t.meta).length;
    const visible = this.tools.filter((t) => !t.meta && this.isVisible(t)).length;
    return { eager: meta, revealed: visible, hidden: this.tools.length - meta - visible };
  }

  // Replaces the SDK list handler so hidden tools stay registered (and callable —
  // graceful dispatch) while tools/list only advertises the visible set.
  installListHandler(): void {
    if (this.tools.length === 0) {
      throw new Error('installListHandler() requires at least one registered tool');
    }
    this.server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.tools.filter((t) => this.isVisible(t)).map((t) => this.toToolJson(t)),
    }));
  }

  private toToolJson(tool: ToolEntry): { name: string; description: string; inputSchema: unknown; annotations: Record<string, unknown> } {
    let inputSchema = this.jsonSchemaCache.get(tool.name);
    if (!inputSchema) {
      inputSchema = z.toJSONSchema(z.object(tool.inputShape), { target: 'draft-7', io: 'input' });
      this.jsonSchemaCache.set(tool.name, inputSchema);
    }
    return {
      name: tool.name,
      description: tool.description,
      inputSchema,
      annotations: tool.annotations,
    };
  }
}
