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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8'));

async function main() {
  if (process.argv.includes('auth')) {
    const { runAuthFlow } = await import('./auth.js');
    await runAuthFlow(process.argv);
    return;
  }

  // MCP server mode — no console.log (stdio is the MCP channel)
  const server = new McpServer({
    name: 'mcp-google-multi',
    version: pkg.version,
  });
  registerGmailTools(server);
  registerDriveTools(server);
  registerCalendarTools(server);
  registerSheetsTools(server);
  registerDocsTools(server);
  registerContactsTools(server);
  registerSearchConsoleTools(server);
  registerTasksTools(server);
  registerMeetTools(server);
  const optional = new Set(getOptionalBundles());
  if (optional.has('forms')) registerFormsTools(server);
  if (optional.has('chat')) registerChatTools(server);
  if (optional.has('alertcenter')) registerAlertCenterTools(server);
  if (getAdminAccounts().length > 0) registerAdminTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  process.exit(1);
});
