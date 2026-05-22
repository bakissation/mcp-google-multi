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
import { registerAdminTools, registerAlertCenterTools } from './tools/admin.js';
import { getOptionalBundles, getAdminAccounts } from './auth.js';
import { ToolRegistry } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8'));

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

  // MCP server mode — no console.log (stdio is the MCP channel)
  const server = new McpServer({
    name: 'mcp-google-multi',
    version: pkg.version,
  });
  const registry = new ToolRegistry(server);
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
  if (optional.has('alertcenter')) registerAlertCenterTools(registry);
  if (getAdminAccounts().length > 0) registerAdminTools(registry);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  process.exit(1);
});
