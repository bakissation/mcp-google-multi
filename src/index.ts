// accounts.ts handles dotenv loading (must happen before any other imports that read env)
import './accounts.js';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerGmailTools } from './tools/gmail.js';
import { registerDriveTools } from './tools/drive.js';
import { registerCalendarTools } from './tools/calendar.js';
import { registerSheetsTools } from './tools/sheets.js';
import { registerDocsTools } from './tools/docs.js';
import { registerContactsTools } from './tools/contacts.js';

async function main() {
  // Route: auth CLI or MCP server
  if (process.argv.includes('auth')) {
    const { runAuthFlow } = await import('./auth.js');
    await runAuthFlow(process.argv);
    return;
  }

  // MCP server mode — no console.log (stdio is the MCP channel)
  const server = new McpServer({
    name: 'mcp-google-multi',
    version: '1.0.0',
  });

  registerGmailTools(server);
  registerDriveTools(server);
  registerCalendarTools(server);
  registerSheetsTools(server);
  registerDocsTools(server);
  registerContactsTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  process.exit(1);
});
