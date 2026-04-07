# mcp-google-multi

A local [MCP](https://modelcontextprotocol.io) server that gives Claude Code (and any MCP client) access to **Gmail**, **Google Drive**, **Google Calendar**, **Google Sheets**, **Google Docs**, and **Google Contacts** across multiple Google accounts simultaneously.

## Features

- **Multi-account** -- manage any number of Google accounts from a single server
- **73 tools** -- Gmail (21), Drive (15), Calendar (11), Sheets (9), Docs (8), Contacts (9)
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

### Google Sheets (9 tools)

| Tool | Description |
|------|-------------|
| `sheets_create` | Create a new spreadsheet |
| `sheets_get` | Get spreadsheet metadata (title, sheets/tabs, named ranges) |
| `sheets_read_range` | Read cell values from a range (A1 notation) |
| `sheets_write_range` | Write values to a range |
| `sheets_append_rows` | Append rows after existing data |
| `sheets_clear_range` | Clear values from a range (keeps formatting) |
| `sheets_batch_read` | Read multiple ranges at once |
| `sheets_batch_write` | Write to multiple ranges at once |
| `sheets_add_sheet` | Add a new tab/sheet to a spreadsheet |

### Google Docs (8 tools)

| Tool | Description |
|------|-------------|
| `docs_create` | Create a new document |
| `docs_get` | Get document metadata (title, revision, named ranges) |
| `docs_read` | Read document content as plain text |
| `docs_insert_text` | Insert text at a position or at the end |
| `docs_replace_text` | Find and replace all occurrences |
| `docs_delete_range` | Delete content in an index range |
| `docs_update_style` | Update text formatting (bold, italic, font, size) |
| `docs_insert_table` | Insert a table at a position |

### Google Contacts (9 tools)

| Tool | Description |
|------|-------------|
| `contacts_search` | Search contacts by name, email, phone, or organization |
| `contacts_get` | Get a single contact by resource name |
| `contacts_list` | List all contacts (paginated) |
| `contacts_create` | Create a new contact |
| `contacts_update` | Update an existing contact |
| `contacts_delete` | Delete a contact |
| `contacts_groups_list` | List all contact groups (labels) |
| `contacts_group_members` | List members of a contact group |
| `contacts_group_create` | Create a new contact group |

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
   - [Google Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com)
   - [Google Docs API](https://console.cloud.google.com/apis/library/docs.googleapis.com)
   - [People API](https://console.cloud.google.com/apis/library/people.googleapis.com)
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
│       ├── calendar.ts   # 11 Calendar tools
│       ├── sheets.ts     # 9 Sheets tools
│       ├── docs.ts       # 8 Docs tools
│       └── contacts.ts   # 9 Contacts tools
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
| `spreadsheets` | Read/write Google Sheets |
| `documents` | Read/write Google Docs |
| `contacts` | Read/write Google Contacts |

## Troubleshooting

**"GOOGLE_ACCOUNTS is not set"** -- Make sure your `.env` file exists in the project root and has the `GOOGLE_ACCOUNTS` variable set.

**"No token file found for account X"** -- Run `npm run auth -- <alias>` to authenticate that account.

**"Port 4242 is already in use"** -- Another process is using port 4242. Close it and retry the auth flow.

**Token refresh errors** -- Delete the token file at `tokens/<alias>/token.json` and re-authenticate.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

[MIT](LICENSE)
