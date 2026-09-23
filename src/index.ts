#!/usr/bin/env node
// First import: triggers accounts.js module load (env files + registry) before
// anything else. Named to also pull the server-only empty-registry guard (BR-4).
import { assertServerAccountsConfigured, getAccountSet } from './accounts.js';
import { accountsAssertRequired, assertNoEnvAccountsMode, assertNoEnvOptionalScopesMode, isMultiTenantBoot, mtBootGates } from './boot-gates.js';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import type { Transport } from "@modelcontextprotocol/server";
import { unknownToolMessage } from './services.js';
import { type ToolRegistry, resolveDiscoveryMode } from './registry.js';
import { isAllowed, describePolicy } from './write-control.js';
import { buildIdentityContext } from './identity.js';
import { buildRegistry } from './compose.js';
import { registerSetupPrompt } from './setup-prompt.js';
import { applyNetTuning } from './net-tuning.js';
import { argNormalizationEnabled, withArgNormalization, withValidationEnvelope, type StrictArgOptions } from './arg-normalize.js';
import { unknownArgMode } from './arg-strict.js';
import { envValueSource } from './env-load.js';
import { loadConfigFile } from './config-file.js';
import { initUsageMetrics, resolveUsageMetrics, sourceLabel, type Metrics } from './usage-metrics.js';

applyNetTuning();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8'));

/** Unknown-argument screening options, or undefined when the feature is off.
 * Shared by both transports so a mistyped argument behaves identically. */
function strictArgOptions(registry: ToolRegistry, metrics: Metrics | null): StrictArgOptions | undefined {
  const mode = unknownArgMode();
  if (mode === 'off') return undefined;
  return {
    mode,
    declaredFor: (tool) => registry.declaredKeys(tool),
    siblingsFor: (tool, keys) => registry.siblingSpellings(tool, keys),
    unknownTool: (name) => unknownToolMessage(registry, name),
    onDrop: metrics ? (tool, keys) => metrics.recordArgDrop(tool, keys) : undefined,
  };
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

  if (process.argv.includes('metrics')) {
    const { runMetricsCli } = await import('./metrics-cli.js');
    const { GENERATED_METHOD_TOOLS, CURATED_METHOD_IDS } = await import('./tools/generated/method-map.js');
    const envSrc = envValueSource('GOOGLE_USAGE_METRICS');
    let configValue: boolean | undefined;
    try {
      configValue = loadConfigFile(undefined, 'throw')?.usageMetrics;
    } catch { /* an invalid config never blocks reading local metrics files */ }
    const state = resolveUsageMetrics(process.env, configValue, envSrc?.kind === 'file' ? envSrc.file : undefined);
    process.exitCode = runMetricsCli(process.argv, {
      enabled: state.enabled,
      promotion: { methodMap: GENERATED_METHOD_TOOLS, curatedIds: CURATED_METHOD_IDS },
    });
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

  // Transport derivation FIRST: the accounts gate below is transport-aware
  // (a multi-tenant HTTP deploy legitimately boots with zero accounts).
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

  // BR-4: the SERVER never boots with an empty registry — stdio always, HTTP
  // when single-owner. The bootstrap and diagnostic CLIs above already
  // returned. A multi-tenant boot instead refuses the two process-wide env
  // vectors that would leak one operator's accounts/scopes into every tenant.
  const mt = isMultiTenantBoot();
  if (accountsAssertRequired(wantStdio, mt)) assertServerAccountsConfigured();
  if (mt) {
    assertNoEnvAccountsMode();
    assertNoEnvOptionalScopesMode();
  }

  // Resolve (or provision) the master key BEFORE serving: the hard guard is
  // specced "fatal at startup", never mid-dispatch.
  const { resolveMasterKey } = await import('./master-key.js');
  resolveMasterKey();

  // Local usage metrics: fail-closed resolve, self-announcing source, null
  // when off (no wrapper, no dir, nothing initializes). One instance per
  // transport so `boots` keys stay honest under `both`.
  const envSrc = envValueSource('GOOGLE_USAGE_METRICS');
  const metricsState = resolveUsageMetrics(
    process.env,
    loadConfigFile()?.usageMetrics,
    envSrc?.kind === 'file' ? envSrc.file : undefined,
  );
  if (metricsState.warning) process.stderr.write(metricsState.warning);
  const metricsInstances: Metrics[] = [];
  const initMetricsFor = (transport: string, mode: string): Metrics | null => {
    const m = initUsageMetrics(metricsState, { version: pkg.version as string, mode, transport });
    if (m) {
      metricsInstances.push(m);
      process.stderr.write(`local usage metrics: on ${sourceLabel(metricsState.source)} -> ${m.statusLine()}\n`);
    }
    return m;
  };
  if (!metricsState.enabled && metricsState.source.kind !== 'default') {
    process.stderr.write(`local usage metrics: off ${sourceLabel(metricsState.source)}\n`);
  }
  const flushMetrics = () => { for (const m of metricsInstances) m.shutdown(); };
  process.on('exit', flushMetrics);
  if (metricsState.enabled) {
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      process.once(sig, () => {
        flushMetrics();
        // stdio has no other signal handler; preserve terminate-on-signal.
        if (!wantHttp) process.exit(sig === 'SIGINT' ? 130 : 143);
      });
    }
  }

  // Build one McpServer + registry per transport at boot (P1 / BV gap #4:
  // never rebuilt per request); `both` runs the two concurrently.
  if (wantStdio) {
    const server = new McpServer({ name: 'mcp-google-multi', version: pkg.version });
    const stdioMetrics = initMetricsFor('stdio', resolveDiscoveryMode());
    const registry = buildRegistry(server, buildIdentityContext(process.env, { transport: 'stdio' }), undefined, stdioMetrics);
    registry.installListHandler();
    registerSetupPrompt(server);
    // Outbound runs outermost-first, so the composition is deliberate: the
    // envelope rewrite is INNERMOST (last to touch the frame), the tap sits
    // above it (classifying the ORIGINAL validation prose), arg normalization
    // outermost. The tap only counts outbound JSON-RPC error frames (no
    // handler ran) plus id->tool names.
    let transport: Transport = withValidationEnvelope(new StdioServerTransport(), {
      isKnownTool: (n) => registry.hasTool(n),
      defaultAccount: () => getAccountSet().defaultAccount,
    });
    if (stdioMetrics) {
      const { tapUsageMetrics } = await import('./metrics-tap.js');
      transport = tapUsageMetrics(transport, stdioMetrics, (n) => registry.hasTool(n));
    }
    const strictStdio = strictArgOptions(registry, stdioMetrics);
    await server.connect(
      argNormalizationEnabled() || strictStdio
        ? withArgNormalization(
            transport,
            // Gated exactly as the HTTP leg gates `argShapeFor`. Passing the
            // shape unconditionally made stdio rename keys while
            // GOOGLE_ARG_NORMALIZE=off, so the same call succeeded on stdio
            // and failed on HTTP once screening rejects.
            argNormalizationEnabled() ? (n) => registry.argShape(n) : () => undefined,
            undefined,
            stdioMetrics ? (tool, n) => stdioMetrics.recordArgFix(tool, n) : undefined,
            strictStdio,
          )
        : transport,
    );
  }

  if (wantHttp) {
    const { HttpTransportHost, parseOwnerEmails } = await import('./http-transport.js');
    const owners = parseOwnerEmails(process.env);
    const gates = mtBootGates();
    if (gates?.multiTenant) {
      // Same fail-fast SHAPE, different condition: an ungated HTTP endpoint
      // must never boot; under tenancy the gate is "a valid provisioning
      // mechanism exists", not a flat owner allowlist.
      gates.assertProvisioningGate();
    } else {
      // BR3 / C13: the owner allowlist is the entire multi-tenant collapse;
      // refuse to open an ungated HTTP endpoint.
      if (owners.length === 0) {
        process.stderr.write(
          'E_OWNER_EMAILS_REQUIRED: MCP_TRANSPORT includes http but MCP_OWNER_EMAILS is empty. Set MCP_OWNER_EMAILS to the Google email(s) allowed to authenticate.\n',
        );
        process.exit(1);
      }
    }
    // BR7: stateless HTTP cannot push tools/list_changed, so it forces curated.
    const configuredMode = (process.env.GOOGLE_DISCOVERY ?? '').trim().toLowerCase();
    if (configuredMode && configuredMode !== 'curated') {
      process.stderr.write(`GOOGLE_DISCOVERY="${configuredMode}" is ignored over HTTP; the stateless transport forces "curated".\n`);
    }
    const httpServer = new McpServer({ name: 'mcp-google-multi', version: pkg.version });
    const httpMetrics = initMetricsFor('http', 'curated');
    const registry = buildRegistry(httpServer, buildIdentityContext(process.env, { transport: 'http' }), 'curated', httpMetrics);
    registry.installListHandler();
    registerSetupPrompt(httpServer);

    // B13: mount the OAuth 2.1 AS (legs A + B) + the Bearer authenticator.
    const { buildAuthServer } = await import('./oauth-as.js');
    const { jwtSecretFrom } = await import('./mcp-token.js');
    const { resolveJwtKey, resolveMasterKeyForDispatch } = await import('./master-key.js');
    const { OAuth2Client } = await import('googleapis-common');
    const { writeToken } = await import('./token-store.js');
    const { resolveScopesForAccount } = await import('./auth.js');
    const { configDir } = await import('./config-file.js');
    const { getAccountSet } = await import('./accounts.js');
    const googleClient = () =>
      new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, `${httpCfg.publicUrl}/callback`);
    // Only trust the id_token email when Google marks it verified (#8).
    const verifiedEmailFromIdToken = (idToken?: string): string | undefined => {
      if (!idToken) return undefined;
      try {
        const [, payload] = idToken.split('.');
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as { email?: string; email_verified?: boolean | string };
        const verified = claims.email_verified === true || claims.email_verified === 'true';
        return verified ? claims.email : undefined;
      } catch {
        return undefined;
      }
    };
    const authServer = buildAuthServer(
      {
        base: httpCfg.publicUrl,
        resourceUri: httpCfg.resourceUri,
        secret: jwtSecretFrom(resolveJwtKey().key),
        ownerEmails: owners,
        cimdIssuers: (process.env.MCP_CIMD_ALLOWED_ISSUERS ?? 'claude.ai').split(',').map((s) => s.trim()).filter(Boolean),
        accessTtlSec: Number(process.env.MCP_ACCESS_TTL) || undefined,
        masterKey: resolveMasterKeyForDispatch().key,
        refreshStorePath: path.join(configDir(), 'mcp-tokens.enc'),
      },
      {
        buildGoogleAuthUrl: ({ flow, alias, state }) => {
          if (flow === 'alias_reauth' && alias) {
            const cfg = getAccountSet().configs[alias];
            // openid+email so /callback can bind the returned identity to the alias.
            return googleClient().generateAuthUrl({
              access_type: 'offline',
              prompt: 'consent',
              scope: [...new Set([...resolveScopesForAccount(alias), 'openid', 'email'])],
              login_hint: cfg?.email,
              state,
            });
          }
          return googleClient().generateAuthUrl({ scope: ['openid', 'email'], prompt: 'select_account', state });
        },
        exchangeCode: async (code, flow) => {
          const { tokens } = await googleClient().getToken(code);
          const email = verifiedEmailFromIdToken(tokens.id_token ?? undefined);
          // owner_gate discards Google tokens (identity proof only); alias_reauth
          // keeps them but still needs the email for the identity binding.
          return { tokens: flow === 'owner_gate' ? {} : (tokens as Record<string, unknown>), email };
        },
        writeToken: (alias, tokens) => writeToken(alias, tokens),
        aliasEmail: (alias) => getAccountSet().configs[alias]?.email,
        log: (l) => process.stderr.write(`[as] ${l}\n`),
      },
    );
    // BV-1: over HTTP, a dead/missing per-account token surfaces a clickable
    // re-auth link into the AS's alias_reauth flow instead of a stdio CLI hint.
    const { setHttpReauthBase } = await import('./reauth-hint.js');
    setHttpReauthBase(httpCfg.publicUrl);
    // Wizard consent over HTTP: hand out the clientless AS link instead of
    // binding a loopback listener (single-owner flow; a tenancy host installs
    // its own signed-mint context here).
    const { setWizardHttpConsent } = await import('./tools/account-wizard.js');
    setWizardHttpConsent({
      mintConsentUrl: (alias) => `${httpCfg.publicUrl}/authorize?flow=alias_reauth&alias=${encodeURIComponent(alias)}`,
    });

    let httpTap: ((t: Transport) => Transport) | undefined;
    if (httpMetrics) {
      const { tapUsageMetrics } = await import('./metrics-tap.js');
      httpTap = (t) => tapUsageMetrics(t, httpMetrics, (n) => registry.hasTool(n));
    }
    const host = new HttpTransportHost({
      server: httpServer,
      config: httpCfg,
      version: pkg.version,
      ownerConfigured: owners.length > 0,
      authenticate: authServer.authenticate,
      routes: authServer.routes,
      log: (l) => process.stderr.write(`[http] ${l}\n`),
      argShapeFor: argNormalizationEnabled() ? (n) => registry.argShape(n) : undefined,
      metricsTap: httpTap,
      validationEnvelope: {
        isKnownTool: (n: string) => registry.hasTool(n),
        defaultAccount: () => getAccountSet().defaultAccount,
      },
      onArgRename: httpMetrics ? (tool: string, n: number) => httpMetrics.recordArgFix(tool, n) : undefined,
      strictArgs: strictArgOptions(registry, httpMetrics),
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
