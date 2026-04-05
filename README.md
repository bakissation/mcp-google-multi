# mcp-google-multi

A local MCP (Model Context Protocol) server that gives Claude Code access to Gmail, Google Drive, and Google Calendar across multiple Google accounts simultaneously.

## Features

- **Multi-account** — manage 3 Google accounts (`ic`, `personal`, `fatoura`) from a single server
- **37 tools** — Gmail (21), Drive (15), Calendar (11)
- **Auto-refresh** — OAuth tokens refresh transparently and persist to disk
- **Stdio transport** — Claude Code spawns it as a local subprocess, no hosting needed

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
│       ├── gmail.ts      # 21 Gmail tools
│       ├── drive.ts      # 15 Drive tools
│       └── calendar.ts   # 11 Calendar tools
├── tokens/               # OAuth tokens per account (gitignored)
├── dist/                 # Compiled output (gitignored)
├── .env                  # Google OAuth credentials (gitignored)
├── .env.example          # Template for .env
├── package.json
└── tsconfig.json
```

## OAuth Scopes

- `gmail.modify` — read, label, trash, delete emails
- `gmail.send` — send emails
- `drive` — full Drive access (read, upload, share, delete)
- `calendar` — full calendar access

## Adding / Changing Accounts

Edit `src/accounts.ts` to add or modify account aliases, then rebuild and re-auth:

```bash
npm run build
node dist/index.js auth --account <new-alias>
```

## License

Private
