# Tool Coverage

Every tool takes an `account` argument matching one of your `GOOGLE_ACCOUNTS` aliases. **Create / update / delete tools are gated by [write-control](./README.md#write-control-deny-by-default)** — deny-by-default; reads are always available. Run `mcp-google-multi config check` to see exactly which CUD tools your current profile enables.

~170 tools across the services below. Tools load **[discover-first](./README.md#discover-first-tools-tiny-idle-context)**: each service also exposes a `{service}_discover` meta-tool, and only those appear in `tools/list` until discovered (everything stays directly callable). `GOOGLE_TOOLSETS` can switch whole services off. Anything not listed below is reachable through the **[escape hatch](./README.md#escape-hatch-any-workspace-rest-method)** (`google_api_search` + `google_api_call`). (Codegen'd dedicated tools for the long tail are on the [roadmap](https://github.com/bakissation/mcp-google-multi/milestones).)

## Gmail

| Tool | Description |
|------|-------------|
| `gmail_search` | Search messages with Gmail query syntax |
| `gmail_read` | Read a full message by ID |
| `gmail_read_thread` | Read all messages in a thread |
| `gmail_send` | Send an email (optional `htmlBody` for multipart/alternative) |
| `gmail_download_attachment` | Download an email attachment to local disk |
| `gmail_create_draft` | Create a draft (optional `htmlBody` for multipart/alternative) |
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

## Google Drive

| Tool | Description |
|------|-------------|
| `drive_search` | Search files with Drive query syntax (shared drives included) |
| `drive_read` | Read file content (exports Workspace docs as text) |
| `drive_list` | List files in a folder or root |
| `drive_upload` | Upload a local file (optional `convertTo` imports as a native Google Doc/Sheet/Slides) |
| `drive_download` | Download a binary file to local disk |
| `drive_export` | Export Docs/Sheets/Slides to PDF, DOCX, XLSX, Markdown, etc. |
| `drive_create_folder` | Create a new folder |
| `drive_update` | Rename, move, or replace file content |
| `drive_delete` | Permanently delete a file (irreversible) |
| `drive_trash` / `drive_untrash` / `drive_empty_trash` | Trash lifecycle |
| `drive_copy` / `drive_move` | Duplicate / move a file |
| `drive_share` | Share with user/group/domain/anyone (`transferOwnership`, `expirationTime`) |
| `drive_list_permissions` / `drive_permission_update` / `drive_remove_permission` | Permission management |
| `drive_comment_create` / `_list` / `_get` / `_update` / `_delete` | Comment CRUD with anchors |
| `drive_reply_create` / `_list` / `_update` / `_delete` | Reply CRUD (`action: resolve｜reopen`) |
| `drive_revision_list` / `_update` / `_delete` | Version history (`keepForever`) |
| `drive_access_proposal_list` / `_resolve` | Triage "Request access" submissions |
| `drive_shared_drives_list` / `drive_shared_drive_get` | Shared drive discovery |
| `drive_get_about` | Storage quota and account info |

## Google Calendar

| Tool | Description |
|------|-------------|
| `calendar_list_calendars` | List all calendars |
| `calendar_list_events` | List/search events with time range |
| `calendar_get_event` | Get a single event by ID |
| `calendar_create_event` / `calendar_update_event` / `calendar_delete_event` | Event CRUD |
| `calendar_quick_add` | Create event from natural language |
| `calendar_move_event` | Move an event between calendars |
| `calendar_list_instances` | List occurrences of a recurring event |
| `calendar_get_freebusy` | Check free/busy times |
| `calendar_create_calendar` | Create a new calendar |

## Google Sheets

| Tool | Description |
|------|-------------|
| `sheets_create` / `sheets_get` | Create / metadata |
| `sheets_read_range` / `sheets_batch_read` | Read values |
| `sheets_write_range` / `sheets_batch_write` / `sheets_append_rows` | Write / append |
| `sheets_clear_range` / `sheets_batch_clear` | Clear values (keeps formatting) |
| `sheets_add_sheet` / `sheets_delete_sheet` / `sheets_duplicate_sheet` / `sheets_update_sheet_properties` | Tab management |
| `sheets_format_cells` / `sheets_update_borders` / `sheets_merge_cells` / `sheets_unmerge_cells` | Formatting |
| `sheets_add_conditional_format_rule` / `sheets_sort_range` / `sheets_set_basic_filter` / `sheets_clear_basic_filter` | Rules / sort / filter |
| `sheets_find_replace` / `sheets_auto_resize_dimensions` / `sheets_set_data_validation` | Find-replace / autosize / validation |
| `sheets_add_named_range` / `sheets_delete_named_range` | Named ranges |
| `sheets_insert_dimension` / `sheets_delete_dimension` | Insert/delete rows or columns |
| `sheets_batch_update` | Generic batchUpdate escape hatch |

## Google Docs

| Tool | Description |
|------|-------------|
| `docs_create` / `docs_get` / `docs_read` | Create / metadata / read text |
| `docs_insert_text` / `docs_replace_text` / `docs_delete_range` | Text editing |
| `docs_update_style` / `docs_update_paragraph_style` / `docs_update_document_style` | Formatting |
| `docs_insert_table` / `docs_modify_table` | Tables |
| `docs_create_named_range` / `docs_delete_named_range` / `docs_replace_named_range_content` | Mail-merge primitive |
| `docs_create_paragraph_bullets` / `docs_delete_paragraph_bullets` | Lists |
| `docs_insert_inline_image` / `docs_insert_page_break` / `docs_insert_section_break` | Media / layout |
| `docs_create_header` / `docs_delete_header` / `docs_create_footer` / `docs_delete_footer` | Headers / footers |
| `docs_add_tab` / `docs_delete_tab` / `docs_update_tab_properties` | Tabs |
| `docs_batch_update` | Generic batchUpdate escape hatch |

## Google Contacts

| Tool | Description |
|------|-------------|
| `contacts_search` / `contacts_get` / `contacts_list` | Read |
| `contacts_create` / `contacts_update` / `contacts_delete` | Contact CRUD |
| `contacts_groups_list` / `contacts_group_members` / `contacts_group_create` | Groups |

## Google Search Console

| Tool | Description |
|------|-------------|
| `searchconsole_sites_list` / `_get` / `_add` / `_delete` | Property management |
| `searchconsole_sitemaps_list` / `_get` / `_submit` / `_delete` | Sitemap management |
| `searchconsole_searchanalytics_query` | Query search analytics |
| `searchconsole_url_inspect` | Inspect a URL |

## Google Tasks

| Tool | Description |
|------|-------------|
| `tasks_lists_list` / `tasks_list_get` / `tasks_list_insert` / `tasks_list_update` / `tasks_list_delete` | Tasklist management |
| `tasks_list` | List tasks (filter by completion, due, updated) |
| `tasks_get` / `tasks_insert` / `tasks_update` / `tasks_delete` | Task CRUD |
| `tasks_move` | Re-parent / re-position / move to another list |
| `tasks_clear` | Delete every completed task |

## Google Meet

| Tool | Description |
|------|-------------|
| `meet_conference_records_list` / `meet_conference_record_get` | Past Meet sessions |
| `meet_recordings_list` / `meet_transcripts_list` / `meet_transcript_entries_list` | Recordings & transcripts |

## Google Forms — optional bundle (`GOOGLE_OPTIONAL_SCOPES=forms`)

| Tool | Description |
|------|-------------|
| `forms_get` / `forms_responses_list` / `forms_response_get` / `forms_watches_list` | Form + responses (read) |

## Google Chat — optional bundle (`GOOGLE_OPTIONAL_SCOPES=chat`)

| Tool | Description |
|------|-------------|
| `chat_spaces_list` / `chat_spaces_get` / `chat_messages_create` / `chat_messages_list` | Spaces & messages |

## Google Workspace Admin — `GOOGLE_ADMIN_ACCOUNTS=<alias…>`

Requires the listed account to be a Workspace **super-admin** (its own OAuth — no service account). Personal `@gmail.com` accounts will 403; never list them.

| Tool | Description |
|------|-------------|
| `reports_activities_list` | Workspace audit log |
| `admin_users_list` / `admin_users_get` | User directory reads |
| `admin_users_update` | User edits (gated by write-control) |
| `admin_groups_list` / `admin_group_members_list` | Group + member reads |

## Not yet available

**Alert Center** (security alerts) requires a service account with domain-wide delegation, which user OAuth can't grant — planned for **[v6](https://github.com/bakissation/mcp-google-multi/milestones)** ([#4](https://github.com/bakissation/mcp-google-multi/issues/4)).
