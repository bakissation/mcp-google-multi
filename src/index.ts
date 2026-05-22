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
import { resolvePolicy, isAllowed, describePolicy, type Policy } from './write-control.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8'));

function buildRegistry(server: McpServer, policy: Policy): ToolRegistry {
  const registry = new ToolRegistry(server, policy);
  registerGmailTools(registry);
  registerDriveTools(registry);
  registerCalendarTools(registry);
  registerSheetsTools(registry);
  registerDocsTools(registry);
  registerContactsTools(registry);
  registerSearchConsoleTools(registry);
  registerTasksTools(registry);
  registerMeetTools(registry);
  const optional = new Set(getOptionalBundles());
  if (optional.has('forms')) registerFormsTools(registry);
  if (optional.has('chat')) registerChatTools(registry);
  if (getAdminAccounts().length > 0) registerAdminTools(registry);
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
    console.log(`Write-control: ${describePolicy(policy)}`);
    console.log(`CUD tools enabled: ${cud.length - disabled.length}/${cud.length}`);
    console.log(`Disabled: ${disabled.map((t) => t.name).join(', ') || '(none)'}`);
    return;
  }

  const policy = resolvePolicy();
  const server = new McpServer({
    name: 'mcp-google-multi',
    version: pkg.version,
  });
  buildRegistry(server, policy);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  process.exit(1);
});
