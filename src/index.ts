import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Load .env from the project root (not CWD) so it works when spawned by Claude Code
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerGmailTools } from './tools/gmail.js';
import { registerDriveTools } from './tools/drive.js';
import { registerCalendarTools } from './tools/calendar.js';

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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  process.exit(1);
});
