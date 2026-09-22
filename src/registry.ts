import type { ListToolsResult, McpServer } from "@modelcontextprotocol/server";
import { z } from 'zod';
import { type Policy, isAllowed, writeDisabledResult, IRREVERSIBLE_TOOLS } from './write-control.js';
import { getAccountSet, refreshAccountSetIfStale } from './accounts.js';
import { compactResult, trimEnabled } from './trim.js';
import { fanoutAccountField, invalidAccountsResult, parseAccountSelector, runFanout } from './fanout.js';
import { MAX_RESPONSE_CHARS } from './executor.js';
import type { ArgKind, ArgShape } from './arg-normalize.js';
import type { Metrics } from './usage-metrics.js';
import { suggestKeys } from './arg-strict.js';
import { classifyScope } from './scope-observability.js';

/** Nothing granted, no profile: asks the BUNDLE CATALOG whether a scope is
 * reachable at all, independently of any account. */
const EMPTY_SCOPES: ReadonlySet<string> = new Set<string>();

// Client-side result budget advertised for tools that do not declare their own
// (fat readers do; see trim.ts). ~50k chars stays well inside a default client
// context limit while leaving room for real list payloads.
const DEFAULT_MAX_RESULT_CHARS = 50_000;

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
  /** anthropic/* client extension keys: honoring clients (Claude Code) read
   * these from the wire Tool's _meta — SDK clients STRIP unknown keys from
   * annotations (closed ToolAnnotationsSchema), so they must never live there. */
  clientMeta?: Record<string, unknown>;
  meta: boolean;
  /** Discovery-codegen provenance (the only tools passing an explicit cud). */
  generated: boolean;
  /** Member of the frozen irreversible set (real send / permanent delete). */
  irreversible: boolean;
  /** Baked per-method scopes (generated tools); curated tools authorize at
   * service/bundle grain and leave this undefined. */
  requiredScopes?: readonly string[];
}

export interface CatalogOperation {
  tool: string;
  summary: string;
  args: string[];
  cud: Cud;
  /** Present only when no scope bundle in the catalog can authorize this
   * method, so the call cannot succeed on any account however it is
   * configured. The tool stays callable: graceful dispatch then returns the
   * real scope error rather than a bare "not found". */
  unreachable?: true;
}

interface ToolConfig {
  description?: string;
  inputSchema?: z.ZodRawShape;
  annotations?: Record<string, unknown>;
  // Set only by generated tools (cud from HTTP semantics at gen time): open-ended
  // Discovery verbs (undeploy, wipeout, …) would slip past name-based write-control.
  cud?: Cud;
  requiredScopes?: readonly string[];
  _meta?: Record<string, unknown>;
}

const CUD_OVERRIDES: Record<string, Cud> = {
  drive_untrash: 'update',
  drive_transfer: 'create',
  // read-only resolver; the name's "resolve" verb would otherwise infer update.
  contacts_resolve: 'read',
  // Account management is gated by anthropic/requiresUserInteraction (forced
  // human approval), NOT the Google-data write-control profile — so onboarding
  // works under any profile. cud=read also keeps them off the fan-out path.
  account_add: 'read',
  account_reauth: 'read',
  // Writes a LOCAL MCP-client config, not Google data; gated by
  // requiresUserInteraction. "write" verb would otherwise infer update.
  account_write_config: 'read',
};

const SERVICE_OVERRIDES: Record<string, string> = {
  reports_activities_list: 'admin',
};

// read tools that write local files — same savePath fanned across accounts would clobber
const FANOUT_EXCLUDE = new Set(['gmail_download_attachment', 'drive_download', 'drive_export']);

/** Account-management tools: the `account` they take is the SUBJECT of the
 * operation, not the identity it runs as, so injecting the configured default
 * would silently retarget them. `account_add` would adopt the default as the
 * new alias, and `account_reauth` would re-authenticate the wrong account. */
const DEFAULT_ACCOUNT_EXCLUDE = new Set(['account_add', 'account_reauth']);

/** Unwrap optional/default/nullable to the declared scalar kind (zod 4 defs). */
function scalarKindOf(field: unknown): ArgKind {
  type Def = { type?: string; innerType?: unknown };
  let cur = field as { _zod?: { def?: Def } } | undefined;
  for (let i = 0; i < 4 && cur?._zod?.def; i++) {
    const def = cur._zod.def;
    if (def.type === 'number') return 'number';
    if (def.type === 'boolean') return 'boolean';
    if (def.type === 'optional' || def.type === 'default' || def.type === 'nullable') {
      cur = def.innerType as typeof cur;
      continue;
    }
    return 'other';
  }
  return 'other';
}

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
  private readonly argShapeCache = new Map<string, ArgShape>();
  /** Memoized isUngrantable verdict per tool: the answer depends on the frozen
   * bundle catalog only, so it never changes within a process. */
  private readonly ungrantable = new Map<string, boolean>();
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
    private readonly metrics: Metrics | null = null,
  ) {
    this.policy = policy;
    this.mode = mode;
    this.registerTool = ((name: string, config: ToolConfig, handler: (...a: unknown[]) => unknown) => {
      const service =
        SERVICE_OVERRIDES[name] ?? (name.includes('_') ? name.slice(0, name.indexOf('_')) : name);
      const cud = config.cud ?? inferCud(name);
      // destructiveHint=false claims "additive only" (MCP spec) — updates overwrite, so they stay true.
      // idempotent: reads trivially, deletes (already-gone = same), updates
      // (overwrite converges); creates are not (send twice = two emails).
      const annotations = {
        readOnlyHint: cud === 'read',
        destructiveHint: cud === 'delete' || cud === 'update',
        idempotentHint: cud !== 'create',
        ...config.annotations,
      };
      // A12: forced per-call human approval on the irreversible set, even in
      // bypass mode. Client-enforced via the wire _meta (Claude Code reads
      // anthropic/* ONLY there); the server verdict stays separate.
      // Every tool also advertises a result-size budget: fat readers declare
      // their own, everything else inherits the default, so an uncapped tool
      // can never blow past a client's context limit. Generated tools align
      // with the executor's server-side cap.
      const clientMeta = {
        'anthropic/maxResultSizeChars': config.cud !== undefined ? MAX_RESPONSE_CHARS : DEFAULT_MAX_RESULT_CHARS,
        ...config._meta,
        ...(IRREVERSIBLE_TOOLS.has(name) ? { 'anthropic/requiresUserInteraction': true } : {}),
      };

      // never fan out meta tools: google_api_call infers cud=read but executes writes
      let inputShape = config.inputSchema ?? {};
      let baseHandler = handler;
      const hasAccountField = 'account' in inputShape && !DEFAULT_ACCOUNT_EXCLUDE.has(name);
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
        clientMeta,
        meta: this.registeringMeta,
        generated: config.cud !== undefined,
        irreversible: IRREVERSIBLE_TOOLS.has(name),
        requiredScopes: config.requiredScopes,
      });
      const guarded =
        cud === 'read'
          ? baseHandler
          : (...args: unknown[]) =>
              isAllowed({ name, service, cud, scopes: config.requiredScopes }, policy)
                ? baseHandler(...args)
                : writeDisabledResult(
                    { name, service, cud, scopes: config.requiredScopes },
                    policy,
                    // Concrete by here: default-account injection wraps this.
                    (args[0] as { account?: unknown } | undefined)?.account as string | undefined,
                  );
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
      // Usage metrics wrap OUTERMOST and only when enabled: off means no
      // wrapper exists and the chain is byte-identical to the pre-metrics
      // chain. Fan-out width is derived here (bucketed in the module) so the
      // metrics module never imports fanout.
      const instrumented = this.metrics
        ? this.metrics.wrap(
            { name, service, meta: this.registeringMeta, generated: config.cud !== undefined },
            finalHandler as (...a: unknown[]) => Promise<unknown>,
            (a) => {
              const v = (a as { account?: unknown } | undefined)?.account;
              if (typeof v !== 'string' || (v !== '*' && !v.includes(','))) return 1;
              const sel = parseAccountSelector(v);
              return sel.ok ? sel.aliases.length : 1;
            },
          )
        : finalHandler;
      const { cud: _cud, ...sdkConfig } = config;
      return (server.registerTool as (...a: unknown[]) => unknown)(name, { ...sdkConfig, inputSchema: inputShape, annotations }, instrumented);
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

  /** Declared input-schema keys + scalar kinds for one tool (tools/call arg
   * normalization; the kind drives value coercion on renamed keys). */
  argShape(name: string): ArgShape | undefined {
    const cached = this.argShapeCache.get(name);
    if (cached) return cached;
    const entry = this.tools.find((t) => t.name === name);
    if (!entry) return undefined;
    const shape = new Map<string, ArgKind>();
    for (const [key, field] of Object.entries(entry.inputShape)) shape.set(key, scalarKindOf(field));
    this.argShapeCache.set(name, shape);
    return shape;
  }

  /** Declared argument keys for a tool, in declaration order; undefined when
   * the tool is not registered. Backs unknown-argument screening, which needs
   * the full key list rather than argShape's scalar-kind subset view. */
  declaredKeys(name: string): readonly string[] | undefined {
    const entry = this.tools.find((t) => t.name === name);
    return entry ? Object.keys(entry.inputShape) : undefined;
  }

  /** Keys spelling a similar concept elsewhere in the same service, for the
   * hint on a call whose key matched nothing. Kept only when a key is declared
   * by at least two tools in the service or by a curated one, so one-off
   * generated parameters do not become advice. */
  siblingSpellings(tool: string, unknownKeys: string[]): Array<{ key: string; tools: string[] }> {
    const self = this.tools.find((t) => t.name === tool);
    if (!self) return [];
    const declared = new Set(Object.keys(self.inputShape));
    const byKey = new Map<string, { tools: string[]; curated: boolean }>();
    for (const t of this.tools) {
      // Only tools the agent can actually see in tools/list. A hint naming a
      // registered-but-unadvertised generated tool turns a recoverable error
      // into a dead end: in curated mode 353 tools are registered and 181 are
      // advertised, and the hint used to reach for any of them.
      if (t.service !== self.service || t.name === tool || !this.isVisible(t)) continue;
      for (const key of Object.keys(t.inputShape)) {
        if (declared.has(key)) continue;
        const e = byKey.get(key) ?? { tools: [], curated: false };
        e.tools.push(t.name);
        if (!t.generated) e.curated = true;
        byKey.set(key, e);
      }
    }
    const candidates = [...byKey.entries()].filter(([, e]) => e.tools.length >= 2 || e.curated);
    // Reuse the tiered matcher rather than a substring test: the motivating
    // case (parentId against parentFolderId) fails containment and edit
    // distance alike, which is the whole reason that matcher exists.
    const keys = candidates.map(([key]) => key);
    const hits = new Set(unknownKeys.flatMap((k) => suggestKeys(k, keys)));
    return candidates
      .filter(([key]) => hits.has(key))
      .slice(0, 2)
      .map(([key, e]) => ({ key, tools: e.tools }));
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
        ...(this.isUngrantable(t) ? { unreachable: true as const } : {}),
      }));
  }

  /** The metrics recorder, for hook sites (escape hatch); null when off. */
  get usageMetrics(): Metrics | null {
    return this.metrics;
  }

  /** Every registered tool name, hidden ones included: they stay callable, so
   * a did-you-mean may legitimately point at one. */
  toolNames(): string[] {
    return this.tools.map((t) => t.name);
  }

  /** Membership test against the REGISTERED tool set (hidden tools included:
   * they stay callable). The metrics tap uses this so a client-supplied name
   * can never enter the closed vocabulary. */
  hasTool(name: string): boolean {
    return this.tools.some((t) => t.name === name);
  }

  /** Op-name vocabulary for a service, split by provenance so the capped
   * discover descriptions can list curated ops and only summarize the
   * generated long tail. */
  opNames(service: string): { curated: string[]; generated: string[] } {
    const strip = (n: string) => (n.startsWith(`${service}_`) ? n.slice(service.length + 1) : n);
    const curated: string[] = [];
    const generated: string[] = [];
    for (const t of this.tools) {
      if (t.meta || t.service !== service) continue;
      (t.generated ? generated : curated).push(strip(t.name));
    }
    return { curated: [...new Set(curated)], generated: [...new Set(generated)] };
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

  /**
   * True when NO bundle in the catalog grants any of the method's alternative
   * scopes, so the call cannot succeed on any account under any configuration.
   * Static: it asks the catalog, not an account, so it is safe to cache.
   * `classifyScope` with nothing granted and no profile reports `add_bundle`
   * for a scope some bundle could supply and `unknown_scope` only when none
   * can, which is exactly the distinction wanted here.
   */
  isUngrantable(tool: ToolEntry): boolean {
    if (!tool.requiredScopes || tool.requiredScopes.length === 0) return false;
    const cached = this.ungrantable.get(tool.name);
    if (cached !== undefined) return cached;
    // EVERY alternative must be ungrantable. `classifyMethodScopes` cannot
    // answer this: `add_bundle` and `unknown_scope` share the
    // `not_requestable` rank, so its first-best match hides a grantable
    // alternative that appears later in the list. Discovery scope lists are
    // ANY-OF, so one grantable alternative makes the method reachable.
    const verdict = tool.requiredScopes.every((scope) => {
      const c = classifyScope(scope, EMPTY_SCOPES, EMPTY_SCOPES);
      return c.state === 'not_requestable' && c.reason === 'unknown_scope';
    });
    this.ungrantable.set(tool.name, verdict);
    return verdict;
  }

  isVisible(tool: ToolEntry): boolean {
    const mode = this.effectiveMode();
    // Advertising a tool that can never succeed spends context budget to hand
    // the agent a dead end. It stays registered and callable, so calling it by
    // name still produces the real scope error plus its remediation, and
    // {service}_discover still lists it, marked.
    if (!tool.meta && this.isUngrantable(tool)) return false;
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
    this.server.server.setRequestHandler('tools/list', async () => ({
      // The wire Tool is hand-built because the SDK's own types drop the
      // anthropic/* _meta keys honoring clients read. z.toJSONSchema emits a
      // valid draft-7 object schema by construction, which the SDK's recursive
      // JSON-Schema type cannot infer from our cached `unknown`.
      tools: this.tools.filter((t) => this.isVisible(t)).map((t) => this.toToolJson(t)) as ListToolsResult['tools'],
    }));
  }

  private toToolJson(tool: ToolEntry): { name: string; description: string; inputSchema: unknown; annotations: Record<string, unknown>; _meta?: Record<string, unknown> } {
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
      ...(tool.clientMeta ? { _meta: tool.clientMeta } : {}),
    };
  }
}
