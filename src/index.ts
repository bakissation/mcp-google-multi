#!/usr/bin/env node
import './accounts.js';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GENERATED_SERVICES } from './tools/generated/index.js';
import { GENERATED_GATES, SERVICES } from './services.js';
import { ToolRegistry } from './registry.js';
import { registerDiscoverTools } from './discover.js';
import { registerEscapeTools } from './tools/google-api.js';
import { registerAccountTools } from './tools/accounts-tool.js';
import { getToolsets, toolsetEnabled } from './toolsets.js';
import { resolvePolicy, isAllowed, describePolicy, type Policy } from './write-control.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8'));

function buildRegistry(server: McpServer, policy: Policy): ToolRegistry {
  const registry = new ToolRegistry(server, policy);
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
        const hint = svc.name === 'admin' ? 'set GOOGLE_ADMIN_ACCOUNTS' : `add "${svc.name}" to GOOGLE_OPTIONAL_SCOPES`;
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
        `Note: optional services require their bundle in GOOGLE_OPTIONAL_SCOPES, admin requires GOOGLE_ADMIN_ACCOUNTS.`,
    );
  }
  registerDiscoverTools(registry, policy);
  registerEscapeTools(registry, policy);
  registerAccountTools(registry);
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

  if (process.argv.includes('config') && process.argv.includes('check')) {
    const policy = resolvePolicy();
    const registry = buildRegistry(
      new McpServer({ name: 'mcp-google-multi', version: pkg.version }),
      policy,
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
    console.log(`Tool surface: ${counts.eager} eager (discover + escape hatch), ${counts.hidden} deferred until discovery`);
    console.log(`Escape hatch: google_api_call CUD verdicts follow profile=${policy.profile} and your allow/deny globs`);
    return;
  }

  const policy = resolvePolicy();
  const server = new McpServer({
    name: 'mcp-google-multi',
    version: pkg.version,
  });
  const registry = buildRegistry(server, policy);
  registry.installListHandler();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  process.exit(1);
});
