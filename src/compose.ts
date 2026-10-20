// Registry composition, extracted from index.ts so tests can build registries
// without touching the CLI entrypoint. No import-time side effects of its own.

import { McpServer } from "@modelcontextprotocol/server";
import { GENERATED_SERVICES } from './tools/generated/index.js';
import { GENERATED_GATES, SERVICES, servicesAwaitingRestart, unknownToolMessage } from './services.js';
import { argNormalizationEnabled } from './arg-normalize.js';
import { unknownArgMode } from './arg-strict.js';
import type { ServerTarget } from './http-transport.js';
import { ToolRegistry, type DiscoveryMode } from './registry.js';
import { registerDiscoverTools } from './discover.js';
import { registerEscapeTools } from './tools/google-api.js';
import { accountHealthDepsFor, registerAccountTools } from './tools/accounts-tool.js';
import { registerDiagnoseTool } from './doctor.js';
import { registerAccountWizardTools } from './tools/account-wizard.js';
import { getToolsets, toolsetEnabled } from './toolsets.js';
import { isOwnerContext, type IdentityContext } from './identity.js';
import { resolveScopesForAccount } from './auth.js';
import type { CuratedToolDeps } from './client.js';
import type { ExecuteDeps } from './executor.js';
import type { Metrics } from './usage-metrics.js';
import { localFilesDisabledByEnv, logLocalFilesRootAtStartup } from './tools/_local-files.js';

export interface McpServerOptions {
  /** Sent in the initialize result; omitted entirely when absent or blank. */
  instructions?: string;
}

/** The one place the MCP server is constructed, so an embedding host can pass
 * per-session `instructions` without re-deriving the server identity. */
export function createMcpServer(version: string, opts: McpServerOptions = {}): McpServer {
  const instructions = opts.instructions?.trim() ? opts.instructions : undefined;
  return new McpServer({ name: 'mcp-google-multi', version }, instructions ? { instructions } : undefined);
}

export function buildRegistry(server: McpServer, ctx: IdentityContext, mode?: DiscoveryMode, metrics: Metrics | null = null): ToolRegistry {
  const policy = ctx.policy;
  // The registry's account view IS the context's, not the process global.
  const registry = new ToolRegistry(server, policy, mode, metrics, () => ctx.accounts);
  // ctx.accounts is read per call, never snapshotted here, so a live getter stays live.
  const owner = isOwnerContext(ctx);
  // GOOGLE_LOCAL_FILES=off removes every host-file tool/param for every
  // context, including the owner, regardless of the transport.
  const localFilesEnabled = owner && !localFilesDisabledByEnv();
  // Log (never create) the effective GOOGLE_LOCAL_FILES_DIR root so an
  // operator sees where uploads/downloads/attachments will be confined
  // without triggering a tool call first; the root itself is created
  // lazily, on first actual use, so a read-only or missing HOME (hardened
  // systemd, an isolated service user) cannot fail server startup over a
  // feature this run might never use. `config check` hits this same path.
  if (localFilesEnabled) logLocalFilesRootAtStartup();
  const clientDeps: CuratedToolDeps = { getClientFn: ctx.getClient, localFiles: localFilesEnabled };
  const execDeps: ExecuteDeps = {
    getClientFn: ctx.getClient,
    scopeDeps: {
      readTokenFn: ctx.tokenStore.readToken,
      profileFn: (alias) => resolveScopesForAccount(alias, ctx.accounts),
    },
  };
  const toolsets = getToolsets();
  if (toolsets !== 'all') {
    const known = new Set([...SERVICES.map((s) => s.name), ...GENERATED_SERVICES.map((s) => s.name)]);
    for (const requested of toolsets) {
      if (!known.has(requested)) {
        process.stderr.write(`GOOGLE_TOOLSETS: unknown service "${requested}" ignored\n`);
      }
    }
  }
  for (const svc of SERVICES) {
    if (!toolsetEnabled(toolsets, svc.name)) continue;
    if (svc.enabled && !svc.enabled(ctx.accounts)) {
      if (toolsets !== 'all') {
        const hint = svc.name === 'admin' ? 'set admin on an account/profile (or GOOGLE_ADMIN_ACCOUNTS)' : `add "${svc.name}" to an account's scope profile (or legacy GOOGLE_OPTIONAL_SCOPES)`;
        process.stderr.write(`GOOGLE_TOOLSETS: "${svc.name}" requested but not enabled — ${hint}\n`);
      }
      continue;
    }
    svc.register(registry, clientDeps);
  }
  for (const gen of GENERATED_SERVICES) {
    if (!toolsetEnabled(toolsets, gen.name)) continue;
    const curated = SERVICES.find((s) => s.name === gen.name);
    const gate = curated?.enabled ?? GENERATED_GATES[gen.name]?.enabled;
    if (gate && !gate(ctx.accounts)) {
      if (!curated && toolsets !== 'all') {
        process.stderr.write(`GOOGLE_TOOLSETS: "${gen.name}" requested but not enabled — ${GENERATED_GATES[gen.name].hint}\n`);
      }
      continue;
    }
    gen.register(registry, execDeps);
  }
  if (registry.services().length === 0) {
    const known = [...new Set([...SERVICES.map((s) => s.name), ...GENERATED_SERVICES.map((s) => s.name)])].sort();
    throw new Error(
      `GOOGLE_TOOLSETS="${process.env.GOOGLE_TOOLSETS ?? ''}" selected no enabled services. ` +
        `Known services: ${known.join(', ')}. ` +
        `Note: optional services need their bundle in an account's scope profile (or legacy GOOGLE_OPTIONAL_SCOPES); admin needs an admin account/profile.`,
    );
  }
  registerDiscoverTools(registry, policy);
  registerEscapeTools(registry, policy, execDeps);
  registerAccountTools(registry, accountHealthDepsFor(ctx.tokenStore));
  registerDiagnoseTool(registry, ctx);
  // The wizard edits the owner's config.json and token store; any other
  // context has neither.
  if (owner) registerAccountWizardTools(registry, server, () => servicesAwaitingRestart(registry));
  return registry;
}

/** The per-request hooks bound to one registry: argument shapes, unknown-
 * argument screening and the account a validation envelope names. Both
 * transports and every resolved server target build them here, so a mistyped
 * argument behaves the same wherever it arrives. */
export function requestHooksFor(
  registry: ToolRegistry,
  ctx: Pick<IdentityContext, 'accounts'>,
  metrics: Metrics | null = null,
  env: NodeJS.ProcessEnv = process.env,
): Omit<ServerTarget, 'server'> {
  const mode = unknownArgMode(env);
  return {
    argShapeFor: argNormalizationEnabled(env) ? (tool) => registry.argShape(tool) : undefined,
    strictArgs:
      mode === 'off'
        ? undefined
        : {
            mode,
            declaredFor: (tool) => registry.declaredKeys(tool),
            siblingsFor: (tool, keys) => registry.siblingSpellings(tool, keys),
            unknownTool: (name) => unknownToolMessage(registry, name),
            onDrop: metrics ? (tool, keys) => metrics.recordArgDrop(tool, keys) : undefined,
          },
    validationEnvelope: {
      isKnownTool: (name) => registry.hasTool(name),
      defaultAccount: () => ctx.accounts.defaultAccount,
    },
  };
}
