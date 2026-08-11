import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type Policy, isAllowed, writeDisabledResult } from './write-control.js';
import { getAccountSet, refreshAccountSetIfStale } from './accounts.js';
import { compactResult, trimEnabled } from './trim.js';
import { fanoutAccountField, invalidAccountsResult, parseAccountSelector, runFanout } from './fanout.js';

export type Cud = 'read' | 'create' | 'update' | 'delete';

export type DiscoveryMode = 'lazy' | 'curated' | 'eager';

const DISCOVERY_MODES: DiscoveryMode[] = ['lazy', 'curated', 'eager'];

export function resolveDiscoveryMode(env: NodeJS.ProcessEnv = process.env): DiscoveryMode {
  const raw = (env.GOOGLE_DISCOVERY ?? 'lazy').trim() as DiscoveryMode;
  if (raw && !DISCOVERY_MODES.includes(raw)) {
    // Fail-open to the lean default, but say so — a typo'd mode otherwise
    // looks like tools silently missing (or silently flooding the context).
    process.stderr.write(`GOOGLE_DISCOVERY="${raw}" is not valid (${DISCOVERY_MODES.join(' | ')}); using lazy\n`);
  }
  return DISCOVERY_MODES.includes(raw) ? raw : 'lazy';
}

export interface ToolEntry {
  name: string;
  service: string;
  cud: Cud;
  description: string;
  inputShape: z.ZodRawShape;
  annotations: Record<string, unknown>;
  meta: boolean;
  /** Discovery-codegen provenance (the only tools passing an explicit cud). */
  generated: boolean;
  /** Baked per-method scopes (generated tools); curated tools authorize at
   * service/bundle grain and leave this undefined. */
  requiredScopes?: readonly string[];
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
  // Set only by generated tools (cud from HTTP semantics at gen time): open-ended
  // Discovery verbs (undeploy, wipeout, …) would slip past name-based write-control.
  cud?: Cud;
  requiredScopes?: readonly string[];
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
  type Def = { type?: string; innerType?: { _zod?: { def?: Def } } };
  const def = (field as { _zod?: { def?: Def } } | undefined)?._zod?.def;
  if (!def) return false;
  // A2 made account enums .optional(); unwrap it or fan-out silently dies.
  if (def.type === 'optional') return def.innerType?._zod?.def?.type === 'enum';
  return def.type === 'enum';
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
  /** Configured visibility mode (GOOGLE_DISCOVERY); default lazy = v5 exact. */
  readonly mode: DiscoveryMode;
  /** Agent-toggled runtime overlay (discover_all / discover_reset): lifts a
   * lazy surface to curated without touching the configured mode. */
  private expanded = false;

  constructor(
    private readonly server: McpServer,
    policy: Policy,
    mode: DiscoveryMode = resolveDiscoveryMode(),
  ) {
    this.policy = policy;
    this.mode = mode;
    this.registerTool = ((name: string, config: ToolConfig, handler: (...a: unknown[]) => unknown) => {
      const service =
        SERVICE_OVERRIDES[name] ?? (name.includes('_') ? name.slice(0, name.indexOf('_')) : name);
      const cud = config.cud ?? inferCud(name);
      // destructiveHint=false claims "additive only" (MCP spec) — updates overwrite, so they stay true.
      const annotations = {
        readOnlyHint: cud === 'read',
        destructiveHint: cud === 'delete' || cud === 'update',
        ...config.annotations,
      };

      // never fan out meta tools: google_api_call infers cud=read but executes writes
      let inputShape = config.inputSchema ?? {};
      let baseHandler = handler;
      const hasAccountField = 'account' in inputShape;
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
        generated: config.cud !== undefined,
        requiredScopes: config.requiredScopes,
      });
      const guarded =
        cud === 'read'
          ? baseHandler
          : (...args: unknown[]) =>
              isAllowed({ name, service, cud }, policy)
                ? baseHandler(...args)
                : writeDisabledResult({ name, service, cud }, policy);
      // A2: the ONE default-account injection site — outside the CUD gate and
      // the fan-out parse so both observe a concrete alias; NOT meta-skipped
      // (that is what covers google_api_call with zero bespoke code). Explicit
      // aliases, "*" and CSV pass through untouched.
      const withDefault = !hasAccountField
        ? guarded
        : (...args: unknown[]) => {
            const first = args[0] as { account?: unknown } | undefined;
            const value = first?.account;
            if (value != null && value !== '') return guarded(...args);
            // Refresh here or the unset->configured default transition never
            // heals for a client that always omits account (this branch never
            // reaches getClient's probe). One stat, only on omission.
            refreshAccountSetIfStale();
            const def = getAccountSet().defaultAccount;
            if (!def) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({
                      error: 'E_NO_DEFAULT_ACCOUNT',
                      message: 'No "account" given and no default account is configured.',
                      hint: `Pass account explicitly (valid: ${getAccountSet().aliases.join(', ')}), or set GOOGLE_DEFAULT_ACCOUNT / "defaultAccount" in config.json.`,
                      retriable: false,
                    }),
                  },
                ],
                isError: true,
              };
            }
            return guarded({ ...(first ?? {}), account: def }, ...args.slice(1));
          };
      const finalHandler = this.compactOutput
        ? async (...args: unknown[]) => compactResult(await (withDefault(...args) as Promise<Parameters<typeof compactResult>[0]>))
        : withDefault;
      const { cud: _cud, ...sdkConfig } = config;
      return (server.registerTool as (...a: unknown[]) => unknown)(name, { ...sdkConfig, inputSchema: inputShape, annotations }, finalHandler);
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

  /** discover_all: advertise the full curated set at once. Idempotent. */
  expand(): boolean {
    if (this.expanded || this.effectiveMode() !== 'lazy') return false;
    this.expanded = true;
    this.server.sendToolListChanged();
    return true;
  }

  /** discover_reset: back to the lean meta-only surface. Clears reveals too.
   * BV-8: if a client mishandles a SHRINKING tools/list, this degrades to a
   * no-op for that session — tools stay callable regardless (graceful
   * dispatch), zero correctness impact. */
  collapse(): boolean {
    if (!this.expanded && this.revealed.size === 0) return false;
    this.expanded = false;
    this.revealed.clear();
    this.server.sendToolListChanged();
    return true;
  }

  private effectiveMode(): DiscoveryMode {
    if (this.mode !== 'lazy') return this.mode;
    return this.expanded ? 'curated' : 'lazy';
  }

  isVisible(tool: ToolEntry): boolean {
    const mode = this.effectiveMode();
    return (
      tool.meta ||
      mode === 'eager' ||
      this.revealed.has(tool.service) ||
      (mode === 'curated' && !tool.generated)
    );
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
