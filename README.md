# mcp-google-multi

A local MCP (Model Context Protocol) server that gives Claude Code access to Gmail, Google Drive, and Google Calendar across multiple Google accounts simultaneously.

## Features

- **Multi-account** — manage 3 Google accounts (`ic`, `personal`, `fatoura`) from a single server
- **14 tools** — Gmail (search, read, send, draft), Drive (search, read, list), Calendar (list, get, create, update, delete)
- **Auto-refresh** — OAuth tokens refresh transparently and persist to disk
- **Stdio transport** — Claude Code spawns it as a local subprocess, no hosting needed

## Tools

| Service | Tool | Description |
|---------|------|-------------|
| Gmail | `gmail_search` | Search messages with Gmail query syntax |
| Gmail | `gmail_read` | Read a full message by ID |
| Gmail | `gmail_read_thread` | Read all messages in a thread |
| Gmail | `gmail_send` | Send an email |
| Gmail | `gmail_create_draft` | Create a draft |
| Drive | `drive_search` | Search files with Drive query syntax |
| Drive | `drive_read` | Read file content (exports Workspace docs as text) |
| Drive | `drive_list` | List files in a folder or root |
| Calendar | `calendar_list_calendars` | List all calendars |
| Calendar | `calendar_list_events` | List/search events with time range |
| Calendar | `calendar_get_event` | Get a single event by ID |
| Calendar | `calendar_create_event` | Create an event |
| Calendar | `calendar_update_event` | Update an event |
| Calendar | `calendar_delete_event` | Delete an event |

Every tool accepts an `account` parameter: `"ic"`, `"personal"`, or `"fatoura"`.

## Prerequisites

- Node.js 18+
- A GCP project with **Gmail API**, **Google Drive API**, and **Google Calendar API** enabled
- An OAuth 2.0 Client ID (Desktop app type)

## Setup

### 1. GCP Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create or select a project
3. Enable: **Gmail API**, **Google Drive API**, **Google Calendar API**
4. Go to APIs & Services > Credentials > Create Credentials > OAuth 2.0 Client ID
5. Application type: **Desktop app**
6. Add authorized redirect URI: `http://localhost:4242/oauth2callback`
7. Copy the `client_id` and `client_secret`

### 2. Install & Configure

```bash
git clone <this-repo>
cd mcp-google-multi
npm install
cp .env.example .env
# Edit .env with your client_id and client_secret
```

### 3. Build

```bash
npm run build
```

### 4. Authenticate Accounts

```bash
npm run auth:ic         # opens browser → log in as baki@ideacrafters.com
npm run auth:personal   # opens browser → log in as abdelbaki.berkati@gmail.com
npm run auth:fatoura    # opens browser → log in as baki@fatoura.app
```

Each saves a token to `tokens/<alias>/token.json`. Tokens auto-refresh — you should only need to do this once per account.

### 5. Register in Claude Code

```bash
claude mcp add google-multi -s user -- node /path/to/mcp-google-multi/dist/index.js
```

## Project Structure

```
mcp-google-multi/
├── src/
│   ├── index.ts          # Entry point: MCP server or auth CLI
│   ├── accounts.ts       # Account registry (aliases, emails, token paths)
│   ├── auth.ts           # OAuth flow with local HTTP callback
│   ├── client.ts         # OAuth2Client factory with auto-refresh persistence
│   ├── types.ts          # Shared TypeScript types
│   └── tools/
│       ├── gmail.ts      # 5 Gmail tools
│       ├── drive.ts      # 3 Drive tools
│       └── calendar.ts   # 6 Calendar tools
├── tokens/               # OAuth tokens per account (gitignored)
├── dist/                 # Compiled output (gitignored)
├── .env                  # Google OAuth credentials (gitignored)
├── .env.example          # Template for .env
├── package.json
└── tsconfig.json
```

## OAuth Scopes

- `gmail.modify` — read, send, draft emails
- `gmail.send` — send emails
- `drive` — read Drive files
- `calendar` — full calendar access

## Adding / Changing Accounts

Edit `src/accounts.ts` to add or modify account aliases, then rebuild and re-auth:

```bash
npm run build
node dist/index.js auth --account <new-alias>
```

## License

Private
