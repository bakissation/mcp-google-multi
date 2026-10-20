import type { ListToolsResult, McpServer } from "@modelcontextprotocol/server";
import { z } from 'zod';
import { type Policy, isAllowed, writeDisabledResult, IRREVERSIBLE_TOOLS } from './write-control.js';
import { getAccountSet, isLiveAccountField, refreshAccountSetIfStale, type AccountSet } from './accounts.js';
import { compactResult, trimEnabled } from './trim.js';
import { fanoutAccountField, invalidAccountsResult, noAccountsResult, parseAccountSelector, runFanout } from './fanout.js';
import { MAX_RESPONSE_CHARS } from './executor.js';
import type { ArgKind, ArgShape } from './arg-normalize.js';
import type { Metrics } from './usage-metrics.js';
import { MAX_SUGGESTED_KEYS, suggestKeys } from './arg-strict.js';
import { classifyScope } from './scope-observability.js';
import { hints } from './hint-provider.js';

/** Nothing granted, no profile: asks the BUNDLE CATALOG whether a scope is
 * reachable at all, independently of any account. */
const EMPTY_SCOPES: ReadonlySet<string> = new Set<string>();

// Client-side result budget for tools that do not declare their own (fat
// readers do; see trim.ts); stays well inside a default client context limit.
const DEFAULT_MAX_RESULT_CHARS = 50_000;

// A human reading a real write's confirmation prompt and deciding takes far
// longer than a typical tool round trip; the SDK's 60s request default would
// otherwise time the ask out mid-read on a slow or distracted reviewer.
const ELICIT_TIMEOUT_MS = 5 * 60_000;

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

/** The leading sentence of a (possibly multi-sentence) tool description. */
export function firstSentence(text: string): string {
  let openParens = 0;
  let i = 0;
  const abbrevs = /^(e\.g|i\.e|etc|vs)\.$/i;

  while (i < text.length) {
    const char = text[i];

    if (char === '(') {
      openParens++;
    } else if (char === ')') {
      openParens = Math.max(0, openParens - 1);
    } else if (char === '.' && i + 1 < text.length && text[i + 1] === ' ' && openParens === 0) {
      // Found a period-space outside parentheses
      // Check if it's preceded by an abbreviation (e.g., i.e., etc, vs)
      // Find the word before this period
      let wordStart = i - 1;
      while (wordStart > 0 && /[a-zA-Z.]/.test(text[wordStart - 1])) {
        wordStart--;
      }
      const word = text.slice(wordStart, i + 1);

      if (!abbrevs.test(word)) {
        // Not an abbreviation, so this is a valid sentence boundary
        return text.slice(0, i + 1);
      }
    }
    i++;
  }

  return text;
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
  /** The escape hatch (google_api_call and every generated per-method
   * tool): write-control for these runs INSIDE the handler itself
   * (deny-check, then an elicitation round-trip), not this gate, since
   * the gate here is synchronous and has no multi-name deny list. */
  escapeHatch?: boolean;
}

const CUD_OVERRIDES: Record<string, Cud> = {
  drive_untrash: 'update',
  drive_transfer: 'create',
  // read-only resolver; the name's "resolve" verb would otherwise infer update.
  contacts_resolve: 'read',
  // "respond" matches no write verb; it patches the event (a write).
  calendar_respond_event: 'update',
  // Gated by anthropic/requiresUserInteraction, not write-control, so
  // onboarding works under any profile; cud=read also keeps them off fan-out.
  account_add: 'read',
  account_reauth: 'read',
  // Writes a LOCAL MCP-client config, not Google data; gated by
  // requiresUserInteraction. "write" verb would otherwise infer update.
  account_write_config: 'read',
};

const SERVICE_OVERRIDES: Record<string, string> = {
  reports_activities_list: 'admin',
};

/** The service a tool name belongs to: its prefix, unless overridden. */
export function serviceOf(name: string): string {
  return Object.hasOwn(SERVICE_OVERRIDES, name) ? SERVICE_OVERRIDES[name] : name.includes('_') ? name.slice(0, name.indexOf('_')) : name;
}

// read tools that write local files — same savePath fanned across accounts would clobber
const FANOUT_EXCLUDE = new Set(['gmail_download_attachment', 'drive_download', 'drive_export']);

// cud=read for gating/fan-out, yet they write (local files, the account
// registry, config): advertised as writes so annotation-keyed clients prompt.
const WRITES_DESPITE_READ = new Set([...FANOUT_EXCLUDE, 'account_add', 'account_reauth', 'account_write_config']);

// Their `account` is the SUBJECT of the operation (e.g. the new alias to add),
// not the identity to run as, so injecting the configured default would retarget them.
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

/** A field naming one of the registry's accounts: a baked enum or a live
 * account check (curated tools and generated tools both validate live). */
function isAccountSelector(field: unknown): boolean {
  if (isLiveAccountField(field)) return true;
  type Def = { type?: string; innerType?: { _zod?: { def?: Def } } };
  const def = (field as { _zod?: { def?: Def } } | undefined)?._zod?.def;
  if (!def) return false;
  // Account enums are .optional(); unwrap it or fan-out silently dies.
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
  // Memoized isUngrantable verdict: depends on the frozen bundle catalog only.
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
    // The registry's OWN account view, so one built over a subset never
    // observes (or leaks) the global set.
    private readonly accounts: () => AccountSet = getAccountSet,
  ) {
    this.policy = policy;
    this.mode = mode;
    this.registerTool = ((name: string, config: ToolConfig, handler: (...a: unknown[]) => unknown) => {
      const service = serviceOf(name);
      const cud = config.cud ?? inferCud(name);
      // Every write is destructive (a create is no less consequential than an
      // update); idempotent iff not a create (send twice = two emails).
      const writes = cud !== 'read' || WRITES_DESPITE_READ.has(name);
      const annotations = {
        readOnlyHint: !writes,
        destructiveHint: writes,
        idempotentHint: cud !== 'create',
        ...config.annotations,
      };
      // Irreversible-set approval and the result-size budget are both
      // client-enforced via the wire _meta (anthropic/*); the server verdict stays separate.
      const clientMeta = {
        'anthropic/maxResultSizeChars': config.cud !== undefined ? MAX_RESPONSE_CHARS : DEFAULT_MAX_RESULT_CHARS,
        ...config._meta,
        ...(IRREVERSIBLE_TOOLS.has(name) ? { 'anthropic/requiresUserInteraction': true } : {}),
      };

      // never fan out meta tools: google_api_call infers cud=read but executes writes
      let inputShape = config.inputSchema ?? {};
      let baseHandler = handler;
      const hasAccountField = 'account' in inputShape && !DEFAULT_ACCOUNT_EXCLUDE.has(name);
      if (cud === 'read' && !this.registeringMeta && !FANOUT_EXCLUDE.has(name) && isAccountSelector(inputShape.account)) {
        const description = (inputShape.account as z.ZodType).description ?? 'Google account alias';
        inputShape = { ...inputShape, account: fanoutAccountField(description, () => this.accounts().aliases) };
        baseHandler = async (...args: unknown[]) => {
          const first = args[0] as { account?: string } | undefined;
          const parsed = parseAccountSelector(typeof first?.account === 'string' ? first.account : '', this.accounts().aliases);
          if (!parsed.ok) return invalidAccountsResult(parsed.invalid, this.accounts().aliases);
          if (parsed.aliases.length === 0) return noAccountsResult();
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
        cud === 'read' || config.escapeHatch
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
      // The ONE default-account injection site, outside the CUD gate and the
      // fan-out parse (not meta-skipped, which is what covers google_api_call).
      const withDefault = !hasAccountField
        ? guarded
        : (...args: unknown[]) => {
            const first = args[0] as { account?: unknown } | undefined;
            const value = first?.account;
            if (value != null && value !== '') return guarded(...args);
            // Refresh here, or a client that always omits account never heals
            // the unset->configured default transition (getClient's probe is unreached).
            refreshAccountSetIfStale();
            const def = this.accounts().defaultAccount;
            if (!def) {
              const accountSet = this.accounts();
              const accounts = accountSet.aliases.map((alias) => ({ alias, email: accountSet.configs[alias]?.email ?? '' }));
              const rendered = hints()?.render({ kind: 'no_default_account', accounts });
              const pairs = accounts.map((a) => `${a.alias}=${a.email}`).join(', ');
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({
                      error: 'E_NO_DEFAULT_ACCOUNT',
                      message: 'No "account" given and no default account is configured.',
                      hint: rendered?.hint ?? `Pass account explicitly (valid: ${pairs}), or set GOOGLE_DEFAULT_ACCOUNT / "defaultAccount" in config.json.`,
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
      // Usage metrics wrap outermost, only when enabled (off = byte-identical
      // to the pre-metrics chain); fan-out width is derived here so the metrics module never imports fanout.
      const instrumented = this.metrics
        ? this.metrics.wrap(
            { name, service, meta: this.registeringMeta, generated: config.cud !== undefined },
            finalHandler as (...a: unknown[]) => Promise<unknown>,
            (a) => {
              const v = (a as { account?: unknown } | undefined)?.account;
              if (typeof v !== 'string' || (v !== '*' && !v.includes(','))) return 1;
              const sel = parseAccountSelector(v, this.accounts().aliases);
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

  /**
   * Server-side MCP elicitation: asks the connected human to confirm an
   * escape-hatch write. `unsupported` covers every way asking can fail
   * (no elicitation capability, the transport cannot deliver a mid-call
   * request, the negotiated protocol era replaced the push-style
   * request, a timeout, a closed connection, ...) uniformly, since the
   * caller's only correct response to any of them is the same: refuse
   * rather than silently proceed without an answer. `cause` lets the
   * caller phrase the refusal correctly: `http_transport` covers BOTH a
   * self-hosted HTTP deployment and an EE hosted tenant, which this
   * server cannot tell apart, so the caller must not suggest
   * GOOGLE_PROFILE there (a hosted tenant cannot set it); the other
   * causes are stdio-only, where the caller IS the operator and that
   * suggestion is safe.
   *
   * `policy.transport === 'http'` refuses before ever touching
   * elicitInput, regardless of what the client declared. This server's
   * HTTP (EE) transport dispatches every `/mcp` call through a fresh,
   * disposable transport with `enableJsonResponse: true` (see
   * docs/internals.md); a mid-call server-to-client request has nothing
   * to be delivered over there, so even a client that DID declare the
   * capability would otherwise just hang until elicitInput's own
   * request timeout before this failed closed anyway, not fail fast.
   * stdio keeps one live connection for the whole call, so it is
   * unaffected and still attempts a real elicitation below.
   *
   * The capability check (same pattern account-wizard.ts's form
   * elicitation already uses) covers the remaining case on stdio: a
   * client that never declared the capability is refused immediately
   * too, instead of attempting the call and only finding out once
   * elicitInput's own request timeout elapses. A bare `elicitation: {}`
   * (no nested `form` key) still counts as form support: some clients on
   * the 2025-06-18 protocol revision declare the capability this way,
   * before the form/url sub-modes existed to declare.
   *
   * The confirmation itself gets several minutes, not the SDK's 60s
   * request default: reading a real call and deciding is slower than a
   * typical tool round trip (documented in docs/configuration.md).
   */
  async elicitConfirmation(
    message: string,
  ): Promise<{ action: 'accept' | 'decline' | 'cancel' } | { action: 'unsupported'; reason: string; cause: 'http_transport' | 'no_capability' | 'error' }> {
    if (this.policy.transport === 'http') {
      return {
        action: 'unsupported',
        reason: 'elicitation is not available over this server\'s HTTP transport',
        cause: 'http_transport',
      };
    }
    const caps = this.server.server.getClientCapabilities?.() as { elicitation?: unknown } | undefined;
    if (!caps?.elicitation || typeof caps.elicitation !== 'object') {
      return { action: 'unsupported', reason: 'the connected client has not declared elicitation support', cause: 'no_capability' };
    }
    try {
      const result = await (
        this.server.server as { elicitInput: (params: unknown, options?: { timeout: number }) => Promise<{ action: string }> }
      ).elicitInput(
        { message, requestedSchema: { type: 'object', properties: {} } },
        { timeout: ELICIT_TIMEOUT_MS },
      );
      if (result.action === 'accept' || result.action === 'decline' || result.action === 'cancel') {
        return { action: result.action };
      }
      return { action: 'unsupported', reason: `unexpected elicitation result action "${result.action}"`, cause: 'error' };
    } catch (err) {
      return { action: 'unsupported', reason: err instanceof Error ? err.message : String(err), cause: 'error' };
    }
  }

  services(): string[] {
    return [...new Set(this.tools.filter((t) => !t.meta).map((t) => t.service))];
  }

  /** The registry's OWN alias list: registration-time schema builders (the
   * generated account enums) read this, never the process global. */
  accountAliases(): readonly string[] {
    return this.accounts().aliases;
  }

  /** The registry's OWN account set: handlers needing an account's email or
   * profile read this, never the process global. */
  accountSet(): AccountSet {
    return this.accounts();
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
      // Only tools visible in tools/list: a hint naming a hidden generated
      // tool would turn a recoverable error into a dead end.
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
    // The tiered matcher, not a substring test: parentId vs parentFolderId
    // fails both containment and edit distance.
    const keys = candidates.map(([key]) => key);
    const hits = new Set(unknownKeys.slice(0, MAX_SUGGESTED_KEYS).flatMap((k) => suggestKeys(k, keys)));
    return candidates
      .filter(([key]) => hits.has(key))
      .slice(0, 2)
      .map(([key, e]) => ({ key, tools: e.tools }));
  }

  catalog(service: string, query?: string): CatalogOperation[] {
    const candidates = this.tools.filter((t) => !t.meta && t.service === service);
    const toOp = (t: ToolEntry, summary: string = t.description): CatalogOperation => ({
      tool: t.name,
      summary,
      args: Object.keys(t.inputShape),
      cud: t.cud,
      ...(this.isUngrantable(t) ? { unreachable: true as const } : {}),
    });

    const q = query?.trim().toLowerCase();
    if (!q) return candidates.map((t) => toOp(t));

    // Tokenized OR-match (a strict superset of a plain substring test: a full-string
    // hit implies every one of its tokens also hits) ranked by how many tokens matched.
    const ranked = candidates
      .map((t) => {
        const hay = `${t.name} ${t.description}`.toLowerCase();
        return { t, matched: q.split(/\s+/).filter(Boolean).filter((tok) => hay.includes(tok)).length };
      })
      .filter((r) => r.matched > 0)
      .sort((a, b) => b.matched - a.matched);
    if (ranked.length > 0) return ranked.map((r) => toOp(r.t));

    // Nothing matched: list the whole service so the agent can still browse,
    // one-line summaries only so a wide miss doesn't blow the response budget.
    return candidates.map((t) => toOp(t, firstSentence(t.description)));
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
   * If a client mishandles a SHRINKING tools/list, this degrades to a
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
    // EVERY alternative must be ungrantable (scope lists are ANY-OF); a
    // first-best classifyScope match would hide a grantable one later in the list.
    const verdict = tool.requiredScopes.every((scope) => {
      const c = classifyScope(scope, EMPTY_SCOPES, EMPTY_SCOPES);
      return c.state === 'not_requestable' && c.reason === 'unknown_scope';
    });
    this.ungrantable.set(tool.name, verdict);
    return verdict;
  }

  isVisible(tool: ToolEntry): boolean {
    const mode = this.effectiveMode();
    // Hidden, not unregistered: calling an ungrantable tool by name still
    // produces the real scope error, and {service}_discover still lists it, marked.
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
      // Hand-built: the SDK's own Tool type drops the anthropic/* _meta keys honoring clients read.
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
      inputSchema: this.withLiveAccountEnum(tool, inputSchema),
      annotations: tool.annotations,
      ...(tool.clientMeta ? { _meta: tool.clientMeta } : {}),
    };
  }

  // Refreshes the account enum's values per call (structural schema stays
  // cached), so a cached boot-time list doesn't go stale once account_add runs mid-session.
  private withLiveAccountEnum(tool: ToolEntry, schema: unknown): unknown {
    if (DEFAULT_ACCOUNT_EXCLUDE.has(tool.name)) return schema;
    const s = schema as { properties?: Record<string, unknown> };
    const account = s?.properties?.account as { anyOf?: unknown[]; enum?: unknown[] } | undefined;
    if (!account) return schema;
    const aliases = this.accounts().aliases;
    if (aliases.length === 0) return schema;
    if (Array.isArray(account.anyOf)) {
      // fan-out union: advertise '*' + the live aliases on the selector branch
      // (the one without the CSV pattern), keep the CSV branch as is
      const isSelector = (b: unknown) => (b as { pattern?: unknown }).pattern === undefined;
      if (!account.anyOf.some(isSelector)) return schema;
      const anyOf = account.anyOf.map((b) => (isSelector(b) ? { ...(b as object), enum: ['*', ...aliases] } : b));
      return { ...s, properties: { ...s.properties, account: { ...account, anyOf } } };
    }
    return { ...s, properties: { ...s.properties, account: { ...account, enum: [...aliases] } } };
  }
}
