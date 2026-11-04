# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Versions 4.3.0 to 6.1.0 are not listed here.** Releases from 4.3.0 onward are cut by semantic-release from Conventional Commits and published as [GitHub Releases](https://github.com/bakissation/mcp-google-multi/releases) (`dev` is alpha, `staging` is beta, `main` is stable). This file lists 6.1.1 and later, and the history up to 4.2.0 below.

## [Unreleased]

### Added

- Key APIs accept a Buffer as well as a string: `deriveKey`, `deriveTenantKey`, `encryptToken`, `decryptToken`, `createTokenStore`, `refreshMacKey`, `refreshFamilyTagger`, `jwtSecretFrom` and `RefreshStore` take the key text as a string or as its UTF-8 bytes and derive the same keys, so existing callers are unchanged. `resolveMasterKey` and `resolveJwtKey` results carry the key as `bytes`, and the cached key is held as bytes rather than a string. The per-call derived keys and plaintext are overwritten after use, and `wipeKeyCache`, `wipeTenantKeyMemo` and `wipeRefreshKeyMemo` overwrite the caches for a shutdown path. After a wipe, key derivation, `encryptToken` and every `RefreshStore` write throw `E_KEYS_WIPED` until `rearmKeys()`; the cached resolvers refuse too, and a Buffer that was wiped stays refused. The authorization server's JWT secret is the host's to wipe.
- `MCP_SCRUB_KEY_ENV=1` removes `MASTER_KEY` and `MCP_JWT_KEY` from `process.env` once the server has read them. Off by default.

### Documentation

- Markdown docs aligned with what 6.2 ships: `CLAUDE.md`, `SECURITY.md`, `docs/features.md`, `docs/configuration.md`, `docs/http-setup.md`, the pull request template and the skill's escape-hatch paragraph (#349).
- This changelog brought up to date from 6.1.1.

## [6.2.0-alpha.2](https://github.com/bakissation/mcp-google-multi/releases/tag/v6.2.0-alpha.2) - 2026-11-03

### Fixed

- The package `exports` map now declares the `./http-confirm` and `./scope-observability` subpaths. Both modules shipped in `dist` but could not be imported by name, so a program embedding the package could not set a registry's `httpConfirm` or use `accountScopeSets`, `summarizeToolScopes` and `classifyMethodScopes`. A test imports every declared subpath from the built package. (#347)
- Bumped the googleapis group: `@googleapis/sheets` 18.1.1 to 18.1.2 and `@googleapis/tasks` 17.0.1 to 17.1.0. (#345)

## [6.2.0-alpha.1](https://github.com/bakissation/mcp-google-multi/releases/tag/v6.2.0-alpha.1) - 2026-11-03

First 6.2 prerelease. No breaking changes. 944 tools (197 curated, 747 generated); a default install registers 337.

### Added

**Calendar**
- `calendar_suggest_times` checks free/busy for your primary calendar and each attendee calendar and returns the earliest slots when everyone is free. It is read-only and books nothing. Working hours default to 09:00 to 17:00 Monday to Friday in the primary calendar's time zone; `timeZone`, `workStart`, `workEnd`, `includeWeekends`, `bufferMinutes` and `durationMinutes` adjust the search, over a window of up to 31 days. An attendee whose calendar cannot be read is reported under `unavailable` instead of counted as free.
- `calendar_add_subscription`, `calendar_update_subscription` and `calendar_remove_subscription` manage the calendar list (which calendars an account shows, with what name and colour).
- `calendar_create_event` and `calendar_update_event` take optional `startTimeZone` and `endTimeZone` (IANA names, each end may differ). With a zone, start and end may be wall-clock times without an offset; without one an offset is required. An update with a zone alone re-labels that end at the same instant, and an update with a new time and no zone keeps the zone the end already has. (#330)
- Timed events are now reported in their own time zone, with `startTimeZone` and `endTimeZone`, instead of the calendar's zone. Events without a zone, all-day events and unknown zone names are unchanged. (#330)

**Drive**
- `drive_read` extracts text from PDF and Office files (`.docx`, `.xlsx`, `.pptx`) locally, with no conversion into the user's Drive and no extra scope. PDF and Office files may be up to 10MB, other files keep the 2MB limit. A scanned or encrypted PDF or a corrupt file returns `error:binary` with the reason.
- `drive_upload` takes `localDir` to upload a whole local folder: the folder becomes a new Drive folder under `parentFolderId`, subfolders are recreated and files upload three at a time. The local-files confinement applies per file, hidden entries and symlinks are skipped and listed, and a folder over 200 files is refused before anything is created.
- `drive_move` takes `fileIds` (up to 50) to move many files into one folder in a single call, with a per-file result.

**Contacts**
- `contacts_search_directory` searches the Workspace directory (user profiles and shared domain contacts) by name or email. It needs the new optional `directory` scope bundle (`directory.readonly`, Workspace accounts only).
- `contacts_resolve` falls back to the From, To and Cc headers of recent mail when no contact matches, and returns a single match or an ambiguous list marked `source: "gmail"`. `includeMailHeaders: false` turns it off.

**Chat, Search Console, Analytics**
- `chat_messages_search` finds Chat messages by text, newest first, across one space or the first `maxSpaces` spaces. The result says how many spaces and messages were scanned and sets `truncated` when a cap ended the search.
- `searchconsole_url_inspect` takes `inspectionUrls` (up to 20 URLs of one property), inspected three at a time, with one result per URL. A single `inspectionUrl` behaves as before.
- The generic API call reaches Analytics Admin v1alpha methods (enhanced measurement, Google Signals, access bindings, data filters) through a second api id, `analyticsadmin_v1alpha`. An `unknown_method` hint names the sibling version when a method exists there.

**HTTP transport**
- Writes behind the escape hatch can be confirmed over HTTP without sticky sessions. Clients on the 2026-07-28 protocol revision get an "input required" result with the confirmation prompt and a signed request state, and the retry runs the write only when the accepted answer belongs to the identical call for the same caller. With `MCP_HTTP_CONFIRM_TOKEN=on`, clients on the 2025 revision get `confirmation_required` and a single-use token bound to the caller and the exact call (`MCP_CONFIRM_TTL_SECONDS`, default 300, cap 900; `MCP_CONFIRM_KEY`). The token flag is off by default.
- `hideServices()` on the registry keeps whole services out of `tools/list` in every discovery mode. The tools stay registered and callable by name, and meta tools are never hidden.

**Operations**
- Write-control patterns can match a tool by exact name with `tool:<name>` (globs work, for example `tool:gmail_*`).
- Local usage metrics count protocol revisions and clients as `name@major.minor`. Counts only; names and versions are normalised and capped, and days written before this change load unchanged.
- `doctor` and `config check` report, per account, how many registered tools it can call, how many need a re-auth, how many need a scope bundle that is not in its profile, and how many no bundle can grant. `doctor` also notes when several accounts exist and none is the default. (#114)

### Fixed

- `drive_upload` no longer requires `filename` with `localPath`, and `gmail_download_attachment` no longer requires `filename`. Local-file refusals now carry a hint about where paths resolve.
- `gmail_download_attachment` is recorded in the curated method map under `gmail.users.messages.get`, which it reads first, so write-control globs on that method are correct.
- `create_event` validates `start` and `end` locally and accepts the `{"date"}` and `{"dateTime","timeZone"}` shapes instead of failing at Google with a bare Bad Request. (#330)
- HTTP: a declared body over the cap is answered with 413 `payload_too_large` before it is read, and the client can now read that 413 (on Windows the socket reset used to drop it).
- Reads fanned out with `account: "*"` list accounts that lack the needed scope as skipped, so they no longer make the whole result partial.
- Clearer errors and hints: Admin audit reports default `endTime` and refuse a Gmail query without a window of at most 30 days; a group address passed as a user key points at the group tools; sharing with a non-Google address explains the invitation requirement; GA4 incompatible fields point at `analytics_get_metadata` and the compatibility check; a scope no bundle grants now opens with "Do not retry".
- Argument-name suggestions for common first guesses (for example `limit`, `messageIds`, `find` and `replace`), and for `google_api_call` and `gmail_search` date bounds. Calls with the wrong name are still rejected.

### Security

- Updated the MCP SDK (`@modelcontextprotocol/node` 2.1.2, `@modelcontextprotocol/server` 2.4.0) to bound request bodies and JSON-RPC batch length (GHSA-f897-62hf-6gxq), and used overrides to clear flagged transitive packages (`@hono/node-server`, `qs`, `node-forge`, `minimatch`). `npm audit --omit=dev` reports no vulnerabilities.

### Documentation and CI

- Tool counts updated for the new curated tools; the calendar skill reference regenerated for the time zone inputs.
- CI runs test, docker and pr-guards on the `feat/6.2` integration branch.

## [6.1.2-alpha.1](https://github.com/bakissation/mcp-google-multi/releases/tag/v6.1.2-alpha.1) - 2026-11-03

### Fixed

- Gmail replies stay in the source thread: `gmail_send` and `gmail_create_draft` with `replyToMessageId` now carry the source `threadId` (an explicit `replyToThreadId` still wins).

### Changed

- Dev tooling security patches: npm 11.21.1 and lock-only updates of `undici`, `ip-address`, `http-cache-semantics` and `brace-expansion`. Nothing in the published package changes.
- Deduplicated `gaxios`: `google-auth-library` moves to the gaxios 8 line, so the tree resolves a single gaxios. A test pins that invariant.

### CI

- Release-train guards: reject breaking commits on the 6.x train unless the PR carries `breaking-ok`, compare `package-lock` `libc` fields with the base, require the base to be contained in the head on promotion PRs, and post the bump a promotion will produce. The test workflow fails on drift of the generated `COVERAGE.md` and skill reference, and the registry publish waits for npm to serve the new version.
- The backmerge job reads the release tag through the API instead of a checkout (CodeQL `untrusted-checkout`).

## [6.1.1] - 2026-10-25

Stable release. Notes for 4.3.0 through 6.1.1 are on the [GitHub Releases](https://github.com/bakissation/mcp-google-multi/releases) page.

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
