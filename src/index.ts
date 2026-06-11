#!/usr/bin/env node
import './accounts.js';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerGmailTools } from './tools/gmail.js';
import { registerDriveTools } from './tools/drive.js';
import { registerCalendarTools } from './tools/calendar.js';
import { registerSheetsTools } from './tools/sheets.js';
import { registerDocsTools } from './tools/docs.js';
import { registerContactsTools } from './tools/contacts.js';
import { registerSearchConsoleTools } from './tools/searchconsole.js';
import { registerTasksTools } from './tools/tasks.js';
import { registerMeetTools } from './tools/meet.js';
import { registerFormsTools } from './tools/forms.js';
import { registerChatTools } from './tools/chat.js';
import { registerAdminTools } from './tools/admin.js';
import { getOptionalBundles, getAdminAccounts } from './auth.js';
import { ToolRegistry } from './registry.js';
import { registerDiscoverTools } from './discover.js';
import { getToolsets, toolsetEnabled } from './toolsets.js';
import { resolvePolicy, isAllowed, describePolicy, type Policy } from './write-control.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8'));

const SERVICES: Array<{
  name: string;
  register: (registry: ToolRegistry) => void;
  enabled?: () => boolean;
}> = [
  { name: 'gmail', register: registerGmailTools },
  { name: 'drive', register: registerDriveTools },
  { name: 'calendar', register: registerCalendarTools },
  { name: 'sheets', register: registerSheetsTools },
  { name: 'docs', register: registerDocsTools },
  { name: 'contacts', register: registerContactsTools },
  { name: 'searchconsole', register: registerSearchConsoleTools },
  { name: 'tasks', register: registerTasksTools },
  { name: 'meet', register: registerMeetTools },
  { name: 'forms', register: registerFormsTools, enabled: () => new Set(getOptionalBundles()).has('forms') },
  { name: 'chat', register: registerChatTools, enabled: () => new Set(getOptionalBundles()).has('chat') },
  { name: 'admin', register: registerAdminTools, enabled: () => getAdminAccounts().length > 0 },
];

function buildRegistry(server: McpServer, policy: Policy): ToolRegistry {
  const registry = new ToolRegistry(server, policy);
  const toolsets = getToolsets();
  if (toolsets !== 'all') {
    const known = new Set(SERVICES.map((s) => s.name));
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
  registerDiscoverTools(registry, policy);
  if (registry.tools.length === 0) {
    throw new Error(
      `GOOGLE_TOOLSETS="${process.env.GOOGLE_TOOLSETS ?? ''}" selected no enabled services. ` +
        `Known services: ${SERVICES.map((s) => s.name).join(', ')}. ` +
        `Note: forms/chat require GOOGLE_OPTIONAL_SCOPES, admin requires GOOGLE_ADMIN_ACCOUNTS.`,
    );
  }
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
    console.log(`Disabled: ${disabled.map((t) => t.name).join(', ') || '(none)'}`);
    console.log(`Services: ${registry.services().join(', ')}`);
    console.log(`Tool surface: ${counts.eager} eager (discover), ${counts.hidden} deferred until discovery`);
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
