#!/usr/bin/env node
import './accounts.js';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GENERATED_SERVICES } from './tools/generated/index.js';
import { GENERATED_GATES, SERVICES } from './services.js';
import { ToolRegistry, type DiscoveryMode } from './registry.js';
import { registerDiscoverTools } from './discover.js';
import { registerEscapeTools } from './tools/google-api.js';
import { registerAccountTools } from './tools/accounts-tool.js';
import { registerDiagnoseTool } from './doctor.js';
import { registerAccountWizardTools } from './tools/account-wizard.js';
import { getToolsets, toolsetEnabled } from './toolsets.js';
import { isAllowed, describePolicy } from './write-control.js';
import { buildIdentityContext, type IdentityContext } from './identity.js';
import { registerSetupPrompt } from './setup-prompt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8'));

function buildRegistry(server: McpServer, ctx: IdentityContext, mode?: DiscoveryMode): ToolRegistry {
  const policy = ctx.policy;
  const registry = new ToolRegistry(server, policy, mode);
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
    if (svc.enabled && !svc.enabled()) {
      if (toolsets !== 'all') {
        const hint = svc.name === 'admin' ? 'set admin on an account/profile (or GOOGLE_ADMIN_ACCOUNTS)' : `add "${svc.name}" to an account's scope profile (or legacy GOOGLE_OPTIONAL_SCOPES)`;
        process.stderr.write(`GOOGLE_TOOLSETS: "${svc.name}" requested but not enabled — ${hint}\n`);
      }
      continue;
    }
    svc.register(registry);
  }
  for (const gen of GENERATED_SERVICES) {
    if (!toolsetEnabled(toolsets, gen.name)) continue;
    const curated = SERVICES.find((s) => s.name === gen.name);
    const gate = curated?.enabled ?? GENERATED_GATES[gen.name]?.enabled;
    if (gate && !gate()) {
      if (!curated && toolsets !== 'all') {
        process.stderr.write(`GOOGLE_TOOLSETS: "${gen.name}" requested but not enabled — ${GENERATED_GATES[gen.name].hint}\n`);
      }
      continue;
    }
    gen.register(registry);
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
  registerEscapeTools(registry, policy);
  registerAccountTools(registry);
  registerDiagnoseTool(registry);
  registerAccountWizardTools(registry, server);
  return registry;
}

async function main() {
  if (process.argv.includes('auth')) {
    const { runAuthFlow } = await import('./auth.js');
    await runAuthFlow(process.argv);
    return;
  }

  if (process.argv.includes('migrate-tokens')) {
    const { runMigrateTokens } = await import('./migrate-tokens.js');
    runMigrateTokens();
    return;
  }

  if (process.argv.includes('migrate-config')) {
    const { runMigrateConfig } = await import('./migrate-config.js');
    runMigrateConfig();
    return;
  }

  if (process.argv.includes('doctor')) {
    const { runDoctorCli } = await import('./doctor.js');
    process.exitCode = await runDoctorCli(process.argv, pkg.version);
    return;
  }

  if (process.argv.includes('reset')) {
    const { runResetCli } = await import('./doctor.js');
    process.exitCode = await runResetCli(process.argv);
    return;
  }

  if (process.argv.includes('write-client-config')) {
    const { runWriteClientConfigCli } = await import('./client-config.js');
    process.exitCode = await runWriteClientConfigCli(process.argv);
    return;
  }

  if (process.argv.includes('account') && process.argv.includes('export')) {
    const { runExportCli } = await import('./registry-transfer.js');
    process.exitCode = await runExportCli(process.argv);
    return;
  }

  if (process.argv.includes('account') && process.argv.includes('import')) {
    const { runImportCli } = await import('./registry-transfer.js');
    process.exitCode = await runImportCli(process.argv);
    return;
  }

  if (process.argv.includes('config') && process.argv.includes('check')) {
    const ctx = buildIdentityContext();
    const policy = ctx.policy;
    const registry = buildRegistry(
      new McpServer({ name: 'mcp-google-multi', version: pkg.version }),
      ctx,
    );
    const cud = registry.tools.filter((t) => t.cud !== 'read');
    const disabled = cud.filter((t) => !isAllowed(t, policy));
    const counts = registry.visibleCount();
    console.log(`Write-control: ${describePolicy(policy)}`);
    console.log(`CUD tools enabled: ${cud.length - disabled.length}/${cud.length}`);
    // At full-coverage scale, a flat name dump is unreadable — summarize per
    // service unless the list is short.
    let disabledLine = '(none)';
    if (disabled.length > 0 && disabled.length <= 20) {
      disabledLine = disabled.map((t) => t.name).join(', ');
    } else if (disabled.length > 20) {
      const perService = new Map<string, number>();
      for (const t of disabled) perService.set(t.service, (perService.get(t.service) ?? 0) + 1);
      const summary = [...perService.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([s, n]) => `${s} ${n}`).join(', ');
      disabledLine = `${disabled.length} write tools (${summary}) — enable via GOOGLE_PROFILE / GOOGLE_WRITE_ALLOW`;
    }
    console.log(`Disabled: ${disabledLine}`);
    console.log(`Services: ${registry.services().join(', ')}`);
    console.log(`Discovery mode: ${registry.mode}${registry.mode === 'lazy' ? ' (expand at runtime with discover_all)' : ''}`);
    console.log(`Tool surface: ${counts.eager} eager (discover + escape hatch), ${counts.revealed} advertised, ${counts.hidden} deferred`);
    console.log(`Escape hatch: google_api_call CUD verdicts follow profile=${policy.profile} and your allow/deny globs`);
    const { getAccountSet } = await import('./accounts.js');
    const set = getAccountSet();
    console.log(`Default account: ${set.defaultAccount ? `${set.defaultAccount} (${set.defaultAccountSource})` : '(none — "account" is required per call)'}`);
    const { peekMasterKeyProvenance } = await import('./master-key.js');
    const prov = peekMasterKeyProvenance();
    console.log(`MASTER_KEY: ${prov === 'unprovisioned' ? 'unprovisioned (will be generated on first use)' : prov}`);
    try {
      const { resolveHttpConfig, transportIncludesHttp } = await import('./http-config.js');
      const http = resolveHttpConfig();
      console.log(`Transport: ${http.transport}`);
      if (transportIncludesHttp(http.transport)) {
        console.log(`  HTTP bind: ${http.host}:${http.port}`);
        console.log(`  Public URL: ${http.publicUrl} (resource ${http.resourceUri})`);
        console.log(`  Allowed hosts: ${http.allowedHosts.join(', ')}`);
        console.log(`  Allowed origins: ${http.allowedOrigins.join(', ')}`);
      }
    } catch (e) {
      console.log(`Transport: (config error) ${(e as Error).message}`);
    }
    return;
  }

  const ctx = buildIdentityContext();
  // Resolve (or provision) the master key BEFORE serving: the hard guard is
  // specced "fatal at startup", never mid-dispatch.
  const { resolveMasterKey } = await import('./master-key.js');
  resolveMasterKey();

  const { resolveHttpConfig, transportIncludesHttp } = await import('./http-config.js');
  let httpCfg;
  try {
    httpCfg = resolveHttpConfig();
  } catch (e) {
    process.stderr.write(`Fatal: ${(e as Error).message}\n`);
    process.exit(1);
  }
  const wantStdio = httpCfg.transport === 'stdio' || httpCfg.transport === 'both';
  const wantHttp = transportIncludesHttp(httpCfg.transport);

  // Build one McpServer + registry per transport at boot (P1 / BV gap #4:
  // never rebuilt per request); `both` runs the two concurrently.
  if (wantStdio) {
    const server = new McpServer({ name: 'mcp-google-multi', version: pkg.version });
    const registry = buildRegistry(server, ctx);
    registry.installListHandler();
    registerSetupPrompt(server);
    await server.connect(new StdioServerTransport());
  }

  if (wantHttp) {
    const { HttpTransportHost, loopbackOwnerAuthenticator, parseOwnerEmails, remoteHttpRefusal } = await import(
      './http-transport.js'
    );
    // Until the OAuth AS (B13) lands there is no MCP-client authentication, so
    // refuse any exposed/tunnelled HTTP shape and serve loopback-only.
    const refusal = remoteHttpRefusal(httpCfg);
    if (refusal) {
      process.stderr.write(`${refusal}\n`);
      process.exit(1);
    }
    // BR3: the owner allowlist is the entire multi-tenant collapse; refuse to
    // open an ungated HTTP endpoint.
    const owners = parseOwnerEmails(process.env);
    if (owners.length === 0) {
      process.stderr.write(
        'E_OWNER_EMAILS_REQUIRED: MCP_TRANSPORT includes http but MCP_OWNER_EMAILS is empty. Set MCP_OWNER_EMAILS to the Google email(s) allowed to authenticate.\n',
      );
      process.exit(1);
    }
    // BR7: stateless HTTP cannot push tools/list_changed, so it forces curated.
    const configuredMode = (process.env.GOOGLE_DISCOVERY ?? '').trim().toLowerCase();
    if (configuredMode && configuredMode !== 'curated') {
      process.stderr.write(`GOOGLE_DISCOVERY="${configuredMode}" is ignored over HTTP; the stateless transport forces "curated".\n`);
    }
    const httpServer = new McpServer({ name: 'mcp-google-multi', version: pkg.version });
    const registry = buildRegistry(httpServer, ctx, 'curated');
    registry.installListHandler();
    registerSetupPrompt(httpServer);
    const host = new HttpTransportHost({
      server: httpServer,
      config: httpCfg,
      version: pkg.version,
      ownerConfigured: owners.length > 0,
      authenticate: loopbackOwnerAuthenticator(httpCfg.publicUrl),
      log: (l) => process.stderr.write(`[http] ${l}\n`),
    });
    await host.start();
    process.stderr.write(`HTTP transport listening on http://${httpCfg.host}:${httpCfg.port} (public ${httpCfg.publicUrl})\n`);
    // Graceful shutdown so `docker run --init` (B16) forwards SIGTERM cleanly.
    const shutdown = () => {
      host.close().finally(() => process.exit(0));
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  process.exit(1);
});
