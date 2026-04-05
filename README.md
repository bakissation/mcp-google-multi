# mcp-google-multi

A local [MCP](https://modelcontextprotocol.io) server that gives Claude Code (and any MCP client) access to **Gmail**, **Google Drive**, and **Google Calendar** across multiple Google accounts simultaneously.

## Features

- **Multi-account** -- manage any number of Google accounts from a single server
- **47 tools** -- Gmail (21), Drive (15), Calendar (11)
- **Config-driven** -- accounts defined in `.env`, no code changes needed
- **Auto-refresh** -- OAuth tokens refresh transparently and persist to disk
- **Stdio transport** -- runs as a local subprocess, no hosting needed

## Tools

### Gmail (21 tools)

| Tool | Description |
|------|-------------|
| `gmail_search` | Search messages with Gmail query syntax |
| `gmail_read` | Read a full message by ID |
| `gmail_read_thread` | Read all messages in a thread |
| `gmail_send` | Send an email |
| `gmail_download_attachment` | Download an email attachment to local disk |
| `gmail_create_draft` | Create a draft |
| `gmail_modify_labels` | Add/remove labels on a message (star, archive, mark read, etc.) |
| `gmail_trash` | Move a message to Trash (recoverable) |
| `gmail_delete` | Permanently delete a message (irreversible) |
| `gmail_batch_modify` | Bulk add/remove labels across up to 1000 messages |
| `gmail_batch_delete` | Permanently delete multiple messages (irreversible) |
| `gmail_list_drafts` | List all drafts |
| `gmail_get_draft` | Read a specific draft |
| `gmail_send_draft` | Send an existing draft |
| `gmail_list_labels` | List all labels (system + custom) |
| `gmail_create_label` | Create a custom label |
| `gmail_delete_label` | Delete a label |
| `gmail_get_profile` | Get account email, message count, history ID |
| `gmail_list_history` | Get mailbox changes since a history ID |
| `gmail_get_vacation` | Read vacation responder settings |
| `gmail_set_vacation` | Enable/disable vacation responder |

### Google Drive (15 tools)

| Tool | Description |
|------|-------------|
| `drive_search` | Search files with Drive query syntax |
| `drive_read` | Read file content (exports Workspace docs as text) |
| `drive_list` | List files in a folder or root |
| `drive_upload` | Upload a local file to Drive |
| `drive_download` | Download a binary file to local disk |
| `drive_export` | Export Google Docs/Sheets/Slides to PDF, DOCX, XLSX, Markdown, etc. |
| `drive_create_folder` | Create a new folder |
| `drive_update` | Rename, move, or replace file content |
| `drive_delete` | Permanently delete a file (irreversible) |
| `drive_trash` | Move a file to trash (recoverable) |
| `drive_copy` | Duplicate a file |
| `drive_share` | Share with user/group/domain/anyone |
| `drive_list_permissions` | List who has access to a file |
| `drive_remove_permission` | Revoke access |
| `drive_get_about` | Storage quota and account info |

### Google Calendar (11 tools)

| Tool | Description |
|------|-------------|
| `calendar_list_calendars` | List all calendars |
| `calendar_list_events` | List/search events with time range |
| `calendar_get_event` | Get a single event by ID |
| `calendar_create_event` | Create an event |
| `calendar_update_event` | Update an event |
| `calendar_delete_event` | Delete an event |
| `calendar_quick_add` | Create event from natural language (e.g. "Lunch Thursday 1pm") |
| `calendar_move_event` | Move an event between calendars |
| `calendar_list_instances` | List occurrences of a recurring event |
| `calendar_get_freebusy` | Check free/busy times for calendars |
| `calendar_create_calendar` | Create a new calendar |

Every tool accepts an `account` parameter matching one of your configured aliases.

## Prerequisites

- Node.js 18+
- A Google Cloud project with **Gmail API**, **Google Drive API**, and **Google Calendar API** enabled
- An OAuth 2.0 Client ID (Desktop app type)

## Setup

### 1. Google Cloud Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create or select a project
3. Enable these APIs:
   - [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
   - [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
   - [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
4. Go to **APIs & Services > Credentials > Create Credentials > OAuth 2.0 Client ID**
5. Application type: **Desktop app**
6. Add authorized redirect URI: `http://localhost:4242/oauth2callback`
7. Copy the **Client ID** and **Client Secret**

### 2. Install & Configure

```bash
git clone https://github.com/bakissation/mcp-google-multi.git
cd mcp-google-multi
npm install
cp .env.example .env
```

Edit `.env`:

```env
GOOGLE_CLIENT_ID=your_client_id_here
GOOGLE_CLIENT_SECRET=your_client_secret_here

# Define your accounts as alias:email pairs (comma-separated)
GOOGLE_ACCOUNTS=work:you@company.com,personal:you@gmail.com
```

### 3. Build

```bash
npm run build
```

### 4. Authenticate Accounts

Run the auth flow for each account alias you defined:

```bash
npm run auth -- work       # opens browser -> log in with you@company.com
npm run auth -- personal   # opens browser -> log in with you@gmail.com
```

Each saves a token to `tokens/<alias>/token.json`. Tokens auto-refresh -- you should only need to do this once per account.

### 5. Register in Claude Code

```bash
claude mcp add google-multi -s user -- node /absolute/path/to/mcp-google-multi/dist/index.js
```

Or add it manually to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "google-multi": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-google-multi/dist/index.js"]
    }
  }
}
```

## Adding / Removing Accounts

Edit the `GOOGLE_ACCOUNTS` variable in `.env`, rebuild, and authenticate the new account:

```bash
# Add a new account
# .env: GOOGLE_ACCOUNTS=work:you@company.com,personal:you@gmail.com,freelance:you@freelance.com

npm run build
npm run auth -- freelance
```

No code changes required.

## Project Structure

```
mcp-google-multi/
├── src/
│   ├── index.ts          # Entry point: MCP server or auth CLI
│   ├── accounts.ts       # Account config parser (reads from .env)
│   ├── auth.ts           # OAuth flow with local HTTP callback
│   ├── client.ts         # OAuth2Client factory with auto-refresh
│   ├── types.ts          # Shared TypeScript types
│   └── tools/
│       ├── gmail.ts      # 21 Gmail tools
│       ├── drive.ts      # 15 Drive tools
│       └── calendar.ts   # 11 Calendar tools
├── tokens/               # OAuth tokens per account (gitignored)
├── dist/                 # Compiled output (gitignored)
├── .env                  # Your credentials (gitignored)
├── .env.example          # Template for .env
├── package.json
├── tsconfig.json
└── LICENSE
```

## OAuth Scopes

| Scope | Access |
|-------|--------|
| `gmail.modify` | Read, label, trash, delete emails |
| `gmail.send` | Send emails |
| `drive` | Full Drive access (read, upload, share, delete) |
| `calendar` | Full calendar access |

## Troubleshooting

**"GOOGLE_ACCOUNTS is not set"** -- Make sure your `.env` file exists in the project root and has the `GOOGLE_ACCOUNTS` variable set.

**"No token file found for account X"** -- Run `npm run auth -- <alias>` to authenticate that account.

**"Port 4242 is already in use"** -- Another process is using port 4242. Close it and retry the auth flow.

**Token refresh errors** -- Delete the token file at `tokens/<alias>/token.json` and re-authenticate.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

[MIT](LICENSE)
