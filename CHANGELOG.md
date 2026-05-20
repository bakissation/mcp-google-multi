# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **This file is frozen at v4.2.0.** From v4.3.0 onward, releases are cut automatically by semantic-release from Conventional Commits and published as [GitHub Releases](https://github.com/bakissation/mcp-google-multi/releases) (`dev` → alpha, `staging` → beta, `main` → stable). See the Releases page for current notes.

## [4.2.0] — 2026-05-20

### Added

- `drive_upload` gains an optional `convertTo` parameter. When set to a `application/vnd.google-apps.*` type, Drive converts the upload on import — so you can upload Markdown/HTML/DOCX/TXT and get a native, editable Google Doc/Sheet/Slides/Drawing instead of a stored raw file. Backward compatible: omitting `convertTo` keeps the previous store-as-is behaviour. (#6)

## [4.1.0] — 2026-05-20

> **Re-authenticate accounts listed in `GOOGLE_ADMIN_ACCOUNTS`.** The admin scope set shrank — `apps.alerts` is no longer requested by the admin bundle. Re-run `npm run auth -- <alias>` so the token drops it cleanly.

### Fixed

- **Admin consent no longer blocked by Alert Center.** `apps.alerts` was hardcoded into the user-OAuth admin bundle (`ADMIN_SCOPES`), but Google does not grant that scope through the interactive user-consent flow — it requires a service account with domain-wide delegation. Any account in `GOOGLE_ADMIN_ACCOUNTS` therefore failed the *entire* admin consent with `Error 400: invalid_scope` / "Some requested scopes cannot be shown", taking the working Admin SDK Directory + Reports tools down with it.

### Changed

- `apps.alerts` moved out of `ADMIN_SCOPES` into a new `alertcenter` key in `OPTIONAL_SCOPE_BUNDLES`.
- The two Alert Center tools (`alertcenter_alerts_list`, `alertcenter_alert_get`) now register via `registerAlertCenterTools` behind `GOOGLE_OPTIONAL_SCOPES=alertcenter`, decoupled from the admin bundle. The admin bundle is now 6 tools (Reports + Directory); Alert Center is its own 2-tool optional bundle.
- Added `handleAlertCenterError` with a hint explaining the service-account / domain-wide-delegation requirement.

### Known limitation

- The `alertcenter` bundle is declared-but-non-functional under user OAuth: enabling it requests the scope and registers the tools, but the Alert Center API rejects user-consent tokens. Full support needs a service-account + domain-wide-delegation auth path (tracked in the linked issue).

## [4.0.0] — 2026-05-11

> **Breaking — re-authenticate every account after upgrading.** The base OAuth scope set grew (Tasks + Meet added); existing tokens lack the new scopes and Tasks/Meet tools will 403 until you re-run `npm run auth -- <alias>` for each account.

### Added

**Drive completers (20 tools)**
- `drive_untrash` — restore a trashed file (fixes the one-way door)
- `drive_move` — move a file between folders without delete+recreate
- `drive_empty_trash` — wipe the trash in one call
- `drive_permission_update` — change a permission's role/expiration in place
- `drive_comment_create` / `drive_comment_list` / `drive_comment_get` / `drive_comment_update` / `drive_comment_delete` — full comment CRUD, works on Docs, PDFs and any Drive file
- `drive_reply_create` (with `action: resolve | reopen`) / `drive_reply_list` / `drive_reply_update` / `drive_reply_delete` — reply threads with programmatic resolve/reopen
- `drive_revision_list` / `drive_revision_update` (`keepForever`, `published`) / `drive_revision_delete` — version history + pinning
- `drive_access_proposal_list` / `drive_access_proposal_resolve` — programmatic triage of "Request access" submissions
- `drive_shared_drives_list` / `drive_shared_drive_get` — shared-drive discovery

**Sheets formatting + CRM completers (19 tools)**
- `sheets_delete_sheet`, `sheets_duplicate_sheet`, `sheets_update_sheet_properties` (rename, freeze rows/cols, tab color, hide, grid size)
- `sheets_format_cells` — colors, fonts, alignment, number formats with auto-computed fields mask
- `sheets_update_borders`, `sheets_merge_cells`, `sheets_unmerge_cells`
- `sheets_add_conditional_format_rule` (boolean and gradient rules)
- `sheets_sort_range`, `sheets_set_basic_filter`, `sheets_clear_basic_filter`, `sheets_find_replace` (regex + scope-aware), `sheets_auto_resize_dimensions`
- `sheets_set_data_validation` (dropdowns, checkboxes, numeric/date/custom rules)
- `sheets_add_named_range`, `sheets_delete_named_range`
- `sheets_insert_dimension`, `sheets_delete_dimension`
- `sheets_batch_clear` (values.batchClear)
- `sheets_batch_update` — generic Request[] escape hatch covering the ~70 Sheets batchUpdate Request types

**Docs templating + structure (15 tools + 1 extension)**
- `docs_create_named_range`, `docs_delete_named_range`, `docs_replace_named_range_content` — real mail-merge primitive
- `docs_update_paragraph_style` (alignment, heading, indents, line spacing) and `docs_update_document_style` (page size, margins, header/footer behavior) with auto-computed fields masks
- `docs_create_paragraph_bullets`, `docs_delete_paragraph_bullets`
- `docs_insert_inline_image` (PNG/JPEG/GIF up to 50 MB)
- `docs_insert_page_break`, `docs_insert_section_break`
- `docs_create_header`, `docs_delete_header`, `docs_create_footer`, `docs_delete_footer`
- `docs_modify_table` — single tool with `operation` discriminator for insertRow / insertColumn / deleteRow / deleteColumn / mergeCells / unmergeCells
- `docs_add_tab`, `docs_delete_tab`, `docs_update_tab_properties` — full tabs CRUD
- `docs_batch_update` — generic Request[] escape hatch covering the full 40-type Docs Request union
- `docs_get` extended with `includeTabsContent` and `suggestionsViewMode`

**Tasks API (12 tools)** — new service
- Tasklists: `tasks_lists_list`, `tasks_list_get`, `tasks_list_insert`, `tasks_list_update`, `tasks_list_delete`
- Tasks: `tasks_list`, `tasks_get`, `tasks_insert`, `tasks_update`, `tasks_delete`, `tasks_move`, `tasks_clear`

**Meet v2 (5 tools)** — new service
- `meet_conference_records_list`, `meet_conference_record_get`
- `meet_recordings_list`, `meet_transcripts_list`, `meet_transcript_entries_list`

**Forms (4 tools, optional scope bundle)** — new service
- `forms_get`, `forms_responses_list`, `forms_response_get`, `forms_watches_list`

**Chat (4 tools, optional scope bundle)** — new service
- `chat_spaces_list`, `chat_spaces_get`, `chat_messages_create`, `chat_messages_list`

**Admin SDK (8 tools, admin scope bundle)** — new service
- Reports: `reports_activities_list` (Workspace audit log across all applications)
- Alert Center: `alertcenter_alerts_list`, `alertcenter_alert_get`
- Directory: `admin_users_list`, `admin_users_get`, `admin_users_update` (gated behind `GOOGLE_ALLOW_ADMIN_WRITES`), `admin_groups_list`, `admin_group_members_list`

### Changed

- `drive_share` now accepts `transferOwnership` and `expirationTime`. The `role` enum gained `fileOrganizer` and `organizer`.
- `drive_search` and `drive_list` now always set `supportsAllDrives` + `includeItemsFromAllDrives`. Every other Drive tool that takes a `fileId` also sets `supportsAllDrives`, so shared-drive content works consistently.
- `docs_get` accepts `includeTabsContent` and `suggestionsViewMode`.
- **OAuth scope system is now tiered:**
  - **Base scopes** (always granted): all v3 scopes + `tasks` + `meetings.space.readonly`.
  - **Optional scope bundles** via `GOOGLE_OPTIONAL_SCOPES`: `forms`, `chat`.
  - **Admin scope bundle** per-account via `GOOGLE_ADMIN_ACCOUNTS`: Reports, Alert Center, Directory. Accounts not listed here never request admin scopes — safe for personal Gmail.
  - Admin write operations require an additional `GOOGLE_ALLOW_ADMIN_WRITES=true` env flag.
- Forms / Chat / Admin tool registration is conditional in `src/index.ts` — toolset only loads when its scope bundle is enabled, keeping the surface narrow for non-Workspace setups.
- **Error handling unified** — every service file now delegates 401/403/429/fallback mapping to `handleGoogleApiError` in `src/tools/_errors.ts`. Per-service shims are 3 lines that pass an optional `forbiddenHint` for actionable 403 reasons (admin scope missing, optional bundle not enabled, etc.).
- **Env parsing centralized** — `auth.ts` exports `getOptionalBundles()` / `getAdminAccounts()` / `adminWritesEnabled()`; `index.ts` consumes those instead of re-parsing.
- **Drive downloads/exports** switched from manual `.pipe + .on('finish')` to `node:stream/promises.pipeline`, so source-side errors destroy the writer and don't leak partial files.

### Fixed

- `drive_trash` was hardcoded to set `trashed: true` with no inverse path — restoring a trashed file was impossible through the MCP. Now paired with `drive_untrash`.
- `drive_comment_list` returned `400 Invalid field selection` because the field-mask builder split `replies(...)` across commas, leaking subfields into the top-level selector. Hard-coded the two field lists separately.
- `McpServer` constructor version no longer hardcoded — now reads from `package.json` at startup.

### Security

- **OAuth callback bound to loopback** — `auth.ts` now `.listen(4242, '127.0.0.1', ...)` instead of binding to all interfaces. CSRF state was already strong (32 random bytes); this hardens the network-attack surface during the brief auth window.
- **Account alias path-traversal hardened** — `accounts.ts` now requires `[a-zA-Z0-9_-]+` so a malicious `GOOGLE_ACCOUNTS=../../etc/foo:bar@x.com` can't escape the tokens directory.
- **Drive query injection escape** — `drive_list` escapes `\` and `'` in `folderId` before interpolating into the Drive query literal.
- **npm audit** — bumped transitive `fast-uri`, `hono`, `ip-address`, `express-rate-limit` (advisories in the MCP SDK's HTTP/JSX/JWT paths, which we don't exercise via stdio transport — clean lockfile-only fix).

### Migration

1. `git pull && npm install && npm run build`.
2. Re-authenticate every account: `npm run auth -- <alias>` (for each alias). This grants the new base scopes (Tasks + Meet) — required.
3. If you want Forms/Chat: set `GOOGLE_OPTIONAL_SCOPES=forms,chat` in `.env` before re-authing.
4. If you're a Workspace admin: list the relevant accounts in `GOOGLE_ADMIN_ACCOUNTS=alias1,alias2` in `.env` before re-authing those accounts. Set `GOOGLE_ALLOW_ADMIN_WRITES=true` only if you actually need destructive admin operations.
5. In Google Cloud Console, enable the new APIs you plan to use: **Tasks API**, **Google Meet API**, optionally **Forms API**, **Chat API**, **Admin SDK API**, **Alert Center API**.

## [3.0.1] — 2026-04

Re-tag of 3.0.0 after security/lint/CI cleanup.

## [3.0.0] — 2026-04

Added Google Search Console support (10 tools) and the `webmasters` scope.

## [2.0.0] — 2026-04

Added Sheets, Docs, and Contacts support (26 tools across 3 services).

## [1.0.0] — 2026-03

Initial release with multi-account Gmail, Drive, Calendar support and config-driven account definition.
