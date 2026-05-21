# mcp-google-multi

A local [MCP](https://modelcontextprotocol.io) server that gives Claude Code (and any MCP client) access to **Gmail**, **Google Drive**, **Google Calendar**, **Google Sheets**, **Google Docs**, **Google Contacts**, **Google Search Console**, **Google Tasks**, **Google Meet**, and optionally **Google Forms**, **Google Chat**, and **Google Workspace Admin** APIs across multiple Google accounts simultaneously.

[![npm](https://img.shields.io/npm/v/mcp-google-multi?label=npm&color=cb3837)](https://www.npmjs.com/package/mcp-google-multi)

## Features

- **Multi-account** — manage any number of Google accounts from a single server
- **175 tools** across 13 Google services
- **Tiered OAuth scopes** — base scopes always granted; Forms/Chat/Alert Center are opt-in bundles; Admin scopes are per-account opt-in with a separate safety flag for destructive writes
- **Config-driven accounts** — defined in `.env`, no code changes needed
- **Auto-refresh** — OAuth tokens refresh transparently and persist to disk
- **Stdio transport** — runs as a local subprocess, no hosting needed

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

### Google Drive (35 tools)

| Tool | Description |
|------|-------------|
| `drive_search` | Search files with Drive query syntax (shared drives included) |
| `drive_read` | Read file content (exports Workspace docs as text) |
| `drive_list` | List files in a folder or root |
| `drive_upload` | Upload a local file to Drive (optional `convertTo` imports it as a native Google Doc/Sheet/Slides) |
| `drive_download` | Download a binary file to local disk |
| `drive_export` | Export Google Docs/Sheets/Slides to PDF, DOCX, XLSX, Markdown, etc. |
| `drive_create_folder` | Create a new folder |
| `drive_update` | Rename, move, or replace file content |
| `drive_delete` | Permanently delete a file (irreversible) |
| `drive_trash` | Move a file to trash (recoverable) |
| `drive_untrash` | Restore a trashed file |
| `drive_empty_trash` | Permanently delete every file in trash |
| `drive_copy` | Duplicate a file |
| `drive_move` | Move a file between folders |
| `drive_share` | Share with user/group/domain/anyone (with `transferOwnership` + `expirationTime`) |
| `drive_list_permissions` | List who has access to a file |
| `drive_permission_update` | Change a permission's role / expiration in place |
| `drive_remove_permission` | Revoke access |
| `drive_comment_create` / `_list` / `_get` / `_update` / `_delete` | Full comment CRUD with anchor support |
| `drive_reply_create` / `_list` / `_update` / `_delete` | Reply CRUD; reply.create accepts `action: resolve | reopen` |
| `drive_revision_list` / `_update` / `_delete` | Version history; `keepForever` pins against the 200-version cap |
| `drive_access_proposal_list` / `_resolve` | Triage "Request access" submissions |
| `drive_shared_drives_list` / `drive_shared_drive_get` | Shared drive discovery |
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

### Google Sheets (29 tools)

| Tool | Description |
|------|-------------|
| `sheets_create` | Create a new spreadsheet |
| `sheets_get` | Get spreadsheet metadata |
| `sheets_read_range` / `sheets_batch_read` | Read values |
| `sheets_write_range` / `sheets_batch_write` | Write values |
| `sheets_append_rows` | Append after existing data |
| `sheets_clear_range` / `sheets_batch_clear` | Clear values (preserves formatting) |
| `sheets_add_sheet` / `sheets_delete_sheet` / `sheets_duplicate_sheet` | Tab management |
| `sheets_update_sheet_properties` | Rename, freeze, color, hide, resize |
| `sheets_format_cells` | Colors, fonts, alignment, number formats |
| `sheets_update_borders` | Cell borders with style + color |
| `sheets_merge_cells` / `sheets_unmerge_cells` | Cell merging |
| `sheets_add_conditional_format_rule` | Boolean and gradient conditional formatting |
| `sheets_sort_range` | Multi-column sort |
| `sheets_set_basic_filter` / `sheets_clear_basic_filter` | Filter rows |
| `sheets_find_replace` | Regex-capable, scope-aware find/replace |
| `sheets_auto_resize_dimensions` | Fit rows/columns to content |
| `sheets_set_data_validation` | Dropdowns, checkboxes, custom rules |
| `sheets_add_named_range` / `sheets_delete_named_range` | Named ranges |
| `sheets_insert_dimension` / `sheets_delete_dimension` | Insert/delete rows or columns |
| `sheets_batch_update` | Generic batchUpdate escape hatch (any Request type) |

### Google Docs (27 tools)

| Tool | Description |
|------|-------------|
| `docs_create` | Create a new document |
| `docs_get` | Metadata + optional tab content / suggestionsViewMode |
| `docs_read` | Read document content as plain text |
| `docs_insert_text` | Insert text at position or end |
| `docs_replace_text` | Find and replace |
| `docs_delete_range` | Delete a character range |
| `docs_update_style` | Inline text formatting (bold, italic, font, size) |
| `docs_update_paragraph_style` | Alignment, heading, indents, spacing |
| `docs_update_document_style` | Page size, margins, header/footer behavior |
| `docs_insert_table` | Insert a table |
| `docs_modify_table` | insertRow / insertColumn / deleteRow / deleteColumn / mergeCells / unmergeCells |
| `docs_create_named_range` / `docs_delete_named_range` / `docs_replace_named_range_content` | Mail-merge primitive |
| `docs_create_paragraph_bullets` / `docs_delete_paragraph_bullets` | Bulleted/numbered lists |
| `docs_insert_inline_image` | PNG/JPEG/GIF image insertion |
| `docs_insert_page_break` / `docs_insert_section_break` | Layout breaks |
| `docs_create_header` / `docs_delete_header` / `docs_create_footer` / `docs_delete_footer` | Branded headers and footers |
| `docs_add_tab` / `docs_delete_tab` / `docs_update_tab_properties` | Tabs CRUD |
| `docs_batch_update` | Generic batchUpdate escape hatch (any Request type) |

### Google Contacts (9 tools)

| Tool | Description |
|------|-------------|
| `contacts_search` | Search contacts |
| `contacts_get` | Get one contact |
| `contacts_list` | List contacts (paginated) |
| `contacts_create` | Create a contact |
| `contacts_update` | Update a contact |
| `contacts_delete` | Delete a contact |
| `contacts_groups_list` | List groups |
| `contacts_group_members` | List members of a group |
| `contacts_group_create` | Create a group |

### Google Search Console (10 tools)

| Tool | Description |
|------|-------------|
| `searchconsole_sites_list` | List Search Console properties |
| `searchconsole_sites_get` | Get a property |
| `searchconsole_sites_add` | Add a property |
| `searchconsole_sites_delete` | Remove a property |
| `searchconsole_sitemaps_list` | List sitemaps |
| `searchconsole_sitemaps_get` | Sitemap status |
| `searchconsole_sitemaps_submit` | Submit a sitemap |
| `searchconsole_sitemaps_delete` | Delete a sitemap |
| `searchconsole_searchanalytics_query` | Query search analytics |
| `searchconsole_url_inspect` | Inspect a URL |

### Google Tasks (12 tools) — _new in v4_

| Tool | Description |
|------|-------------|
| `tasks_lists_list` / `tasks_list_get` / `tasks_list_insert` / `tasks_list_update` / `tasks_list_delete` | Tasklist management |
| `tasks_list` | List tasks (filter by completion, due, updated time) |
| `tasks_get` / `tasks_insert` / `tasks_update` / `tasks_delete` | Task CRUD |
| `tasks_move` | Re-parent / re-position / move to another list |
| `tasks_clear` | Delete every completed task |

### Google Meet (5 tools) — _new in v4_

| Tool | Description |
|------|-------------|
| `meet_conference_records_list` | List past Meet sessions |
| `meet_conference_record_get` | Get one record |
| `meet_recordings_list` | Recordings on a record |
| `meet_transcripts_list` | Transcripts on a record |
| `meet_transcript_entries_list` | Per-speaker transcript text |

### Google Forms (4 tools, optional bundle) — _new in v4_

Enable with `GOOGLE_OPTIONAL_SCOPES=forms` in `.env`.

| Tool | Description |
|------|-------------|
| `forms_get` | Form definition |
| `forms_responses_list` | List responses with filter |
| `forms_response_get` | Single response |
| `forms_watches_list` | List Pub/Sub watches |

### Google Chat (4 tools, optional bundle) — _new in v4_

Enable with `GOOGLE_OPTIONAL_SCOPES=chat` in `.env` (combine: `GOOGLE_OPTIONAL_SCOPES=forms,chat`).

| Tool | Description |
|------|-------------|
| `chat_spaces_list` | Spaces the user is in |
| `chat_spaces_get` | One space |
| `chat_messages_create` | Send text or Card v2 |
| `chat_messages_list` | List messages with filter / orderBy |

### Google Workspace Admin (6 tools, admin bundle) — _new in v4_

Enable per-account with `GOOGLE_ADMIN_ACCOUNTS=alias1,alias2` in `.env`. Requires the account to be a Workspace super-admin. Personal `@gmail.com` accounts will 403 — never list them here. Destructive writes additionally require `GOOGLE_ALLOW_ADMIN_WRITES=true`.

| Tool | Description |
|------|-------------|
| `reports_activities_list` | Workspace audit log (login, drive, gmail, admin, token, etc.) |
| `admin_users_list` / `admin_users_get` | User directory reads |
| `admin_users_update` | User edits (gated, see env flag above) |
| `admin_groups_list` / `admin_group_members_list` | Group + member reads |

Every tool accepts an `account` parameter matching one of your configured aliases.

### Google Alert Center (2 tools, optional bundle) — _new in v4_

Enable with `GOOGLE_OPTIONAL_SCOPES=alertcenter` in `.env`.

| Tool | Description |
|------|-------------|
| `alertcenter_alerts_list` / `alertcenter_alert_get` | Security alerts (suspicious login, phishing, leaked password, Drive exfil) |

> **⚠ Requires service-account domain-wide delegation.** Unlike every other bundle, the Alert Center `apps.alerts` scope **cannot** be granted through this server's interactive user-consent OAuth flow — Google rejects it with `Error 400: invalid_scope` / "Some requested scopes cannot be shown". Per [Google's docs](https://developers.google.com/workspace/admin/alertcenter/guides/auth), Alert Center requires a service account with domain-wide delegation. This server is user-OAuth only, so enabling this bundle declares the scope and registers the tools, but the API will reject the resulting tokens until service-account auth is added (see [#4](https://github.com/bakissation/mcp-google-multi/issues/4)). The bundle is kept separate precisely so this limitation never blocks the working admin tools above.

## Prerequisites

- Node.js 18+
- A Google Cloud project with the relevant APIs enabled (see step 1 below)
- An OAuth 2.0 Client ID (Desktop app type)

## Setup

### 1. Google Cloud Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com).
2. Create or select a project.
3. Enable the APIs you intend to use:
   - **Always required:** [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com), [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com), [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com), [Google Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com), [Google Docs API](https://console.cloud.google.com/apis/library/docs.googleapis.com), [People API](https://console.cloud.google.com/apis/library/people.googleapis.com), [Search Console API](https://console.cloud.google.com/apis/library/searchconsole.googleapis.com), [Google Tasks API](https://console.cloud.google.com/apis/library/tasks.googleapis.com), [Google Meet API](https://console.cloud.google.com/apis/library/meet.googleapis.com).
   - **Optional bundles (only if you enable them):** [Google Forms API](https://console.cloud.google.com/apis/library/forms.googleapis.com), [Google Chat API](https://console.cloud.google.com/apis/library/chat.googleapis.com), [Alert Center API](https://console.cloud.google.com/apis/library/alertcenter.googleapis.com) (the `alertcenter` bundle also needs service-account domain-wide delegation — see the Alert Center section above).
   - **Admin bundle (only if you set `GOOGLE_ADMIN_ACCOUNTS`):** [Admin SDK API](https://console.cloud.google.com/apis/library/admin.googleapis.com).
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**.
5. Application type: **Desktop app**.
6. Add authorized redirect URI: `http://localhost:4242/oauth2callback`.
7. Copy the **Client ID** and **Client Secret**.

### 2. Install & Configure

**Option A — from npm (no clone):**

```bash
npm install -g mcp-google-multi    # installs the `mcp-google-multi` CLI
# …or run on demand without installing: npx mcp-google-multi
```

Published with channel dist-tags — `@latest` (stable), `@dev` (alpha), `@staging` (beta); e.g. `npm i -g mcp-google-multi@dev` for the latest alpha.

**Option B — from source:**

```bash
git clone https://github.com/bakissation/mcp-google-multi.git
cd mcp-google-multi
npm install && npm run build
cp .env.example .env
```

Create a `.env` (from source, `.env.example` is the template; from npm, make one in the directory you'll run the server from) with:

```env
GOOGLE_CLIENT_ID=your_client_id_here
GOOGLE_CLIENT_SECRET=your_client_secret_here

# Define your accounts as alias:email pairs (comma-separated)
GOOGLE_ACCOUNTS=work:you@company.com,personal:you@gmail.com

# Optional (v4): enable Forms, Chat, and/or Alert Center tool bundles
# (alertcenter additionally requires service-account domain-wide delegation)
# GOOGLE_OPTIONAL_SCOPES=forms,chat

# Optional (v4): grant Workspace admin scopes to specific accounts
# GOOGLE_ADMIN_ACCOUNTS=work

# Optional (v4): unlock destructive admin writes (admin_users_update)
# GOOGLE_ALLOW_ADMIN_WRITES=true
```

### 3. Build

```bash
npm run build
```

### 4. Authenticate Accounts

```bash
npm run auth -- work       # opens browser → log in with you@company.com
npm run auth -- personal   # opens browser → log in with you@gmail.com
```

Each saves a token to `tokens/<alias>/token.json`. Tokens auto-refresh — you should only need to do this once per account.

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

If you installed from npm, point at the package instead and pass config via `env` (authenticate first with `mcp-google-multi auth --account <alias>`):

```json
{
  "mcpServers": {
    "google-multi": {
      "command": "npx",
      "args": ["-y", "mcp-google-multi"],
      "env": {
        "GOOGLE_CLIENT_ID": "your_client_id_here",
        "GOOGLE_CLIENT_SECRET": "your_client_secret_here",
        "GOOGLE_ACCOUNTS": "work:you@company.com,personal:you@gmail.com"
      }
    }
  }
}
```

## Migrating from v3

v4.0.0 grows the base OAuth scope set (Tasks and Meet are now included by default). Existing v3 tokens lack those scopes and the corresponding tools will 403.

1. `git pull && npm install && npm run build`.
2. Re-authenticate every account: `npm run auth -- <alias>` for each alias.
3. If you want Forms or Chat tools: set `GOOGLE_OPTIONAL_SCOPES=forms,chat` in `.env` **before** re-authing.
4. If you're a Workspace admin: list relevant accounts in `GOOGLE_ADMIN_ACCOUNTS` **before** re-authing those accounts. Set `GOOGLE_ALLOW_ADMIN_WRITES=true` only if you need destructive admin operations.
5. In Google Cloud Console, enable any new APIs you'll use (Tasks, Meet, Forms, Chat, Admin SDK, Alert Center).

## Adding / Removing Accounts

Edit the `GOOGLE_ACCOUNTS` variable in `.env`, rebuild, and authenticate the new account:

```bash
# Add a new account
# .env: GOOGLE_ACCOUNTS=work:you@company.com,personal:you@gmail.com,freelance:you@freelance.com

npm run build
npm run auth -- freelance
```

No code changes required.

## OAuth Scopes

### Base (always granted)

| Scope | Access |
|-------|--------|
| `gmail.modify` | Read, label, trash, delete emails |
| `gmail.send` | Send emails |
| `drive` | Full Drive access (read, upload, share, comments, etc.) |
| `calendar` | Full calendar access |
| `spreadsheets` | Read/write Google Sheets |
| `documents` | Read/write Google Docs |
| `contacts` | Read/write Google Contacts |
| `webmasters` | Google Search Console |
| `tasks` | Read/write Google Tasks |
| `meetings.space.readonly` | Read past Meet conference records and transcripts |

### Optional (per-`GOOGLE_OPTIONAL_SCOPES` env var)

| Bundle key | Scopes |
|------------|--------|
| `forms` | `forms.body`, `forms.responses.readonly` |
| `chat` | `chat.spaces`, `chat.messages`, `chat.messages.create` |
| `alertcenter` | `apps.alerts` — ⚠ requires service-account domain-wide delegation; not grantable via user OAuth (see Alert Center section) |

### Admin (per-`GOOGLE_ADMIN_ACCOUNTS` env var)

Only granted to accounts explicitly listed. Personal Gmail accounts will 403 on these scopes — never list them.

| Scope | Access |
|-------|--------|
| `admin.reports.audit.readonly` | Workspace audit log |
| `admin.directory.user` | Read/write Workspace users (writes also gated by `GOOGLE_ALLOW_ADMIN_WRITES`) |
| `admin.directory.group.readonly` | Read groups |
| `admin.directory.group.member.readonly` | Read group members |

## Project Structure

```
mcp-google-multi/
├── src/
│   ├── index.ts          # Entry point: MCP server or auth CLI
│   ├── accounts.ts       # Account config parser (reads from .env)
│   ├── auth.ts           # Scope tier resolution + OAuth flow
│   ├── client.ts         # OAuth2Client factory with auto-refresh
│   ├── types.ts          # Shared TypeScript types
│   └── tools/
│       ├── _errors.ts          # Shared googleapis error → MCP response mapper
│       ├── gmail.ts            # Gmail (21)
│       ├── drive.ts            # Drive (35)
│       ├── calendar.ts         # Calendar (11)
│       ├── sheets.ts           # Sheets (29)
│       ├── docs.ts             # Docs (27)
│       ├── contacts.ts         # Contacts (9)
│       ├── searchconsole.ts    # Search Console (10)
│       ├── tasks.ts            # Tasks (12) — v4
│       ├── meet.ts             # Meet (5) — v4
│       ├── forms.ts            # Forms (4, optional) — v4
│       ├── chat.ts             # Chat (4, optional) — v4
│       └── admin.ts            # Admin SDK (6, admin) + Alert Center (2, alertcenter bundle) — v4
├── tests/                # vitest unit tests (gmail-mime, path-safety, field-mask helpers)
├── tokens/               # OAuth tokens per account (gitignored)
├── dist/                 # Compiled output (gitignored)
├── .env                  # Your credentials (gitignored)
├── .env.example          # Template for .env
├── CHANGELOG.md
├── CLAUDE.md             # Conventions for AI assistants working on this codebase
├── package.json
├── tsconfig.json
└── LICENSE
```

## Troubleshooting

**"GOOGLE_ACCOUNTS is not set"** — Make sure your `.env` file exists in the project root and has the `GOOGLE_ACCOUNTS` variable set.

**"No token file found for account X"** — Run `npm run auth -- <alias>` to authenticate that account.

**"Port 4242 is already in use"** — Another process is using port 4242. Close it and retry the auth flow.

**Token refresh errors** — Delete the token file at `tokens/<alias>/token.json` and re-authenticate.

**Tasks / Meet tools return 403 after upgrading from v3** — You haven't re-authed since the base scope set grew. Run `npm run auth -- <alias>` for every account.

**`forms_*` or `chat_*` tools missing from the tool list** — They're only registered when `GOOGLE_OPTIONAL_SCOPES` includes their bundle key. Set `GOOGLE_OPTIONAL_SCOPES=forms,chat` (or one of them) in `.env`, rebuild, and re-auth the accounts that need them.

**Admin tools missing or returning 403** — Admin tools only register if `GOOGLE_ADMIN_ACCOUNTS` is set. The listed accounts must be Workspace super-admins, and you must re-auth them after adding the env var so the new scopes are granted. `admin_users_update` additionally requires `GOOGLE_ALLOW_ADMIN_WRITES=true`.

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) first. In short: **open pull requests against the `dev` branch** — changes are promoted `dev → staging → main`, and `main` is release-only. Run `typecheck`/`lint`/`test`/`build` before submitting, and use Conventional Commits.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). For security issues, **do not open a public issue** — see [SECURITY.md](SECURITY.md).

## Author

**Abdelbaki Berkati** — [berkati.xyz](https://berkati.xyz) · [@bakissation](https://github.com/bakissation)

[Read the case study →](https://berkati.xyz/case-studies/mcp-google-multi/)

## License

[MIT](LICENSE)
