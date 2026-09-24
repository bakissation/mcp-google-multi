// S1.12: registry composition, extracted from index.ts so the tenancy module
// (and tests) can build registries without touching the CLI entrypoint. This
// module must stay free of import-time side effects of its own: no argv
// parsing, no process.exit, no prints (accounts.js module-load resolution is
// the one inherited, pre-existing exception on the import chain).

import type { McpServer } from "@modelcontextprotocol/server";
import { GENERATED_SERVICES } from './tools/generated/index.js';
import { GENERATED_GATES, SERVICES, unknownToolMessage } from './services.js';
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

export function buildRegistry(server: McpServer, ctx: IdentityContext, mode?: DiscoveryMode, metrics: Metrics | null = null): ToolRegistry {
  const policy = ctx.policy;
  // The registry's account view IS the context's: fan-out expansion,
  // selector validation and default-account injection all follow this
  // context, not the process global (identical for the free core's one ctx).
  const registry = new ToolRegistry(server, policy, mode, metrics, () => ctx.accounts);
  // Every handler resolves its client, token reads and scope hints through
  // this context; ctx.accounts is read per call, never snapshotted here, so
  // the owner's live getter stays live.
  const owner = isOwnerContext(ctx);
  const clientDeps: CuratedToolDeps = { getClientFn: ctx.getClient, localFiles: owner };
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
  if (owner) registerAccountWizardTools(registry, server);
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
