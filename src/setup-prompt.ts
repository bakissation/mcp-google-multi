import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// B8: the `setup` MCP prompt — the honest ceiling for the un-automatable Google
// Cloud Console prelude (D4). It renders as a native slash command and returns
// a guided, deep-linked walkthrough. BR9: it states plainly which steps have no
// creation API, so the user is never left waiting on automation that will never
// come. BR10: it pre-explains the "unverified app" scare before the consent
// redirect so a self-hoster is not scared off.

export interface SetupOptions {
  /** Public base URL when serving over HTTP; used for the Web client redirect. */
  publicUrl?: string;
}

/** Pure builder (unit-testable): the full guided walkthrough as Markdown. */
export function buildSetupText(opts: SetupOptions = {}): string {
  const base = opts.publicUrl?.replace(/\/+$/, '');
  const clientStep = base
    ? `Create an OAuth client of type **Web application** and add the redirect URI \`${base}/callback\`.`
    : 'Create an OAuth client of type **Desktop app** (for the default stdio transport). If you serve over HTTP instead, create a **Web application** client with redirect `${MCP_PUBLIC_URL}/callback`.';

  return [
    '# Set up mcp-google-multi (Google Cloud Console prelude)',
    '',
    'This server uses **your own** Google OAuth client (BYO). Steps 1–5 below are one-time Google Cloud Console setup that **has no creation API** — Google provides no way to script consent screens or OAuth clients, so this guided walkthrough with deep links is the honest ceiling. Do them once in the browser; the server automates everything after.',
    '',
    '## 1. Create or pick a Google Cloud project',
    'Open https://console.cloud.google.com/projectcreate and create a project (or pick an existing one). Note its project id.',
    '',
    '## 2. Enable the APIs your bundles need',
    'Open https://console.cloud.google.com/apis/library and enable each Workspace API you will use (Gmail, Drive, Calendar, Sheets, Docs, People, …). Each API also has a direct link: `https://console.cloud.google.com/apis/library/<api>.googleapis.com` (e.g. `gmail.googleapis.com`). Later, `diagnose` / `doctor` will flag any API you missed with its exact enable link.',
    '',
    '## 3. Configure the OAuth consent screen',
    'Open https://console.cloud.google.com/auth/audience — set **User type: External**, and under **Test users** add yourself (the owner) and anyone else who will authenticate.',
    '',
    '> **Expect an "unverified app" screen.** Because this is your own self-hosted client (not a Google-verified public app), the consent flow shows *"Google hasn\'t verified this app."* That is normal and safe for a client you created. Click **Advanced → Go to <your app> (unsafe)** to continue — you are trusting your own client. It is not a real security warning for your own setup.',
    '',
    '## 4. Set Publishing status to In production (avoid the 7-day trap)',
    'On the same https://console.cloud.google.com/auth/audience page, set **Publishing status: In production**. While an app is in **Testing**, Google expires refresh tokens after **7 days**, so you would have to re-authenticate every week. Publishing to production removes that expiry. (No verification is required for personal use with your own test users.)',
    '',
    `## 5. Create an OAuth client`,
    `Open https://console.cloud.google.com/auth/clients. ${clientStep} Copy the generated **Client ID** and **Client secret**.`,
    '',
    '## 6. Give the server your client credentials',
    'Put them in real environment variables or in `~/.config/mcp-google-multi/.env` (never in `config.json`):',
    '',
    '```',
    'GOOGLE_CLIENT_ID=<your client id>',
    'GOOGLE_CLIENT_SECRET=<your client secret>',
    '```',
    '',
    '## 7. Add your first account',
    'Run the `account_add` flow (or `npx mcp-google-multi auth --account <alias>`) and complete the browser consent. The server then validates the granted scopes live and stores the encrypted token.',
    '',
    '---',
    'When you are done, run `doctor` (or call `diagnose`) — it checks runtime, config, keys, tokens, scopes, and API enablement, and prints a copy-pasteable fix for anything still wrong.',
  ].join('\n');
}

/** Register the `setup` prompt on the MCP server. */
export function registerSetupPrompt(server: McpServer): void {
  server.registerPrompt(
    'setup',
    {
      title: 'Set up mcp-google-multi',
      description: 'Guided Google Cloud Console prelude: project, APIs, consent screen, OAuth client, and credentials. The one-time browser setup that has no API.',
      argsSchema: { publicUrl: z.string().optional().describe('Public base URL when serving over HTTP (for the Web OAuth client redirect). Omit for stdio.') },
    },
    (args: { publicUrl?: string }) => ({
      messages: [
        {
          role: 'assistant' as const,
          content: { type: 'text' as const, text: buildSetupText({ publicUrl: args?.publicUrl }) },
        },
      ],
    }),
  );
}
