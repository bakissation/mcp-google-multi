---
name: google-workspace
description: Use this skill when working with the mcp-google-multi MCP server to call Gmail, Drive, Calendar, Sheets, Docs, Contacts, Tasks, Meet, Chat, Slides, Forms, Search Console, Admin, or any other Google Workspace tool it exposes. Load it before the first discover or tool call in a session that touches this server, and whenever an account selector, a write-profile refusal, or an unfamiliar argument name needs resolving.
---

# Google Workspace MCP server

This server exposes Google Workspace as MCP tools: a small set of curated,
hand-written tools per service, a long tail of generated tools (one per
Google API Discovery method), and an escape hatch for anything else. Reading
this skill before the first call avoids the two most common failures: guessing
an account when none was configured as default, and guessing an argument name
instead of using the one the tool actually declares.

## 1. Pick the account

Every operational tool takes an `account` argument naming one of the
configured aliases (an alias is a short local name, not the email address
itself). Before calling anything:

1. Call `account_list` first. It returns each alias, its email, admin flag,
   token status, and which alias (if any) is the configured default.
2. If a default account is set, omit `account` on a single-account call;
   the server injects the default. Passing an alias is always safe too.
3. If no default is set and more than one account is configured, you must
   pass `account` explicitly. A call that omits it then fails with
   `E_NO_DEFAULT_ACCOUNT` and a hint listing every `alias=email` pair so you
   can match the one the user means by email, name, or context, rather than
   guessing.
4. Read tools accept `"*"` for the `account` argument to fan out across every
   configured account (bounded concurrency), or a comma-separated subset such
   as `"work,personal"`. Fan-out is read-only by design: write tools, and the
   handful of read tools that save a file to local disk (`drive_download`,
   `drive_export`, `gmail_download_attachment`), take exactly one account.
   A fan-out call returns `{ results: [{ account, ok, data|error }], partial }`
   so one account failing never hides the others.

## 2. Discover before calling

Tools are hidden from the model's context until revealed, but every tool is
always callable by exact name (discovery is a listing optimization, not a
security boundary).

1. Call `{service}_discover` (e.g. `gmail_discover`, `drive_discover`) for the
   service you need. It returns that service's catalog: each tool's name, a
   one-line summary, its arguments, and its read/create/update/delete class.
   An optional `query` argument filters the catalog by keyword.
2. Call the tool **by its exact name** from that catalog. Do not guess a name
   by analogy with another service.
3. `discover_all` reveals every curated tool across all services at once,
   useful before a session doing substantial cross-service work, and
   `discover_reset` collapses back to the configured default afterward to
   reclaim context.
4. A client that loads tool schemas on demand (rather than accepting
   everything a server advertises) may need its own tool-search or
   tool-load step before a newly revealed tool is actually callable. If a
   call to a tool you just discovered fails as unknown on such a client,
   look for that client's own load-tool mechanism before retrying the
   Google call itself.

## 3. Incremental Gmail sweeps

For a recurring "what's new in this mailbox" check, do not re-run the same
broad `gmail_search` on a timer. Two cheaper patterns:

- **`gmail_list_history(startHistoryId, historyTypes)`** with a
  `startHistoryId` you stored from a previous `gmail_get_profile` or
  `gmail_list_history` response. It returns exactly the mailbox changes since that
  point (messages added/deleted, labels added/removed), optionally filtered
  by `historyTypes`. Store the newest history ID you observe and pass it
  next time.
- **`gmail_search(since, until)`** when you have no stored history ID (e.g.
  the first sweep, or after a gap long enough that Gmail's history window
  has expired). Both accept an ISO 8601 date or a date-time with an explicit
  `Z` or UTC offset, never a bare local time.

## 4. Keep results small

Large responses cost context and, for list endpoints, risk a page that looks
complete but isn't. Prefer the per-call controls over reading everything and
discarding most of it:

- On a generated tool or the `google_api_call(queryParams)` escape hatch,
  pass Google's own `fields` partial-response query param to restrict a
  response to the properties you actually need. Curated tools already pick a
  response shape for you, so they don't expose `fields` themselves.
- Leave `full` unset (it defaults to the trimmed shape) on fat readers such as
  `gmail_read(full)` and `gmail_read_thread(full)`; pass `full: true` only
  when you actually need the untruncated body. `calendar_list_events` and
  `calendar_list_instances` always return a trimmed view with no `full`
  argument to toggle; call `calendar_get_event` for one event's complete
  data.
- Cap the page on list and search tools (the argument name varies by tool:
  `drive_search(maxResults)` and `contacts_search(pageSize)` are two
  examples; check `{service}_discover` or the reference table for the exact
  name), and follow `nextPageToken` rather than assuming a short list is the
  whole answer. Where a list reports `truncated`, there is more to fetch.
- On Gmail, pass `headers` on `gmail_read(headers)` or
  `gmail_read_batch(headers)` to fetch only `id`, `threadId`, `labelIds`, and
  the named header values, skipping full body decoding entirely when you
  only need metadata like `Subject` or `From`.

## 5. Write profiles

Reads are never gated. Writes (create/update/delete) are deny-by-default and
controlled by the deployment's `GOOGLE_PROFILE`:

- **`read-only`** (the default): every write refused.
- **`safe-writes`**: ordinary creates and updates on your own data are
  allowed, and so is moving an item to or from Trash (`gmail_trash`,
  `drive_trash`, and their untrash equivalents) since that is recoverable.
  Permanent deletes (emptying Trash, a hard Gmail or Drive delete),
  `drive_transfer` with `move: true`, and privileged writes (anything needing
  an admin, Vault, reseller, or script scope, or registering a push channel)
  stay refused under this profile.
- **`full-writes`**: everything permitted by OAuth scope and the account's
  grants, privileged writes included. An operator's allow and deny patterns
  can widen or narrow any profile.

A write a profile refuses comes back as `{ error: "write_disabled", message,
hint, retriable: false }` rather than a silent no-op or a generic failure.
The `hint` names the exact rule that refused it (a deny pattern, the
privileged-write rule, or the active profile) and what would need to change;
read it rather than retrying the same call. This applies to curated tools.
A generated tool or `google_api_call` follows a different rule: see section 7.

## 6. Argument names are exact

The server never rewrites an argument name: if you pass `pageSize` where a
tool expects `maxResults`, the call fails rather than silently mapping one to
the other. Always use the exact name shown by `{service}_discover` or the
service's reference table in `reference/` next to this file. When in doubt,
discover the tool again and read its declared arguments rather than guessing
from memory or from another service's convention.

Spellings that differ between sibling tools and cost a call when guessed:

- A new name is `newName` on `drive_update` and `drive_copy`, and `name` on
  `drive_create_folder`. A new location is `newParentFolderId` on
  `drive_update` and `drive_move`, and `parentFolderId` everywhere an item is
  created or copied (`drive_upload`, `drive_create_folder`, `drive_copy`,
  `docs_create`, `drive_create_shortcut`). Never `parentId`.
- A rejected call names the declared spelling in its `hint` ("Did you mean ..."):
  fix that one argument and repeat; nothing was sent to Google.

Each `reference/<service>.md` file tables every **curated** tool for that
service: its name, its read/create/update/delete class, a one-line summary,
and every argument with its type, whether it's required, and its
description. **Generated** tools (the long tail, one per Google API
Discovery method) are not tabled individually: they take Google's own
Discovery parameter names directly, and calling `{service}_discover` lists
each one with its arguments at call time.

## 7. Escape hatch for anything not covered

If a service has no curated or generated tool for the operation you need
(or discovery/`reference/` doesn't cover it):

1. Call `google_api_search(query, api, maxResults)` with keywords (optionally
   scoped to one `api` alias) to find the Discovery method id, e.g.
   `drive.revisions.list`.
2. Call `google_api_call(api, methodId, pathParams, queryParams, body)` with
   that method id and whichever of path params, query params, or a JSON body
   it needs.

A read through the escape hatch is never gated, same as everywhere else. A
write (the class is derived from the method's HTTP verb and name) follows a
different rule than named tools: `GOOGLE_READ_ONLY` or a matching
`GOOGLE_WRITE_DENY` still refuses outright, and `GOOGLE_PROFILE=full-writes`
(with `GOOGLE_OUTBOUND_ALLOWLIST` unset) still allows outright, but every
other case, including `GOOGLE_WRITE_ALLOW` (allow lists no longer open the
escape hatch at all), asks the connected human to confirm the real call
before it runs. Expect a write through `google_api_call` or a generated
tool (anything called by its full name directly, not through a curated
tool) to pause for that confirmation unless the deployment runs
`full-writes`; a client that cannot be asked gets back `{ error:
"elicitation_unsupported", ... }` instead, and a decline or cancel comes
back as `{ error: "write_declined", ... }`; neither is worth retrying
without changing the write-control configuration or using a curated tool
instead. Over HTTP a client on the 2026-07-28 protocol revision gets an
"input required" result carrying the confirmation prompt: show it to the user
and repeat the same call with their answer attached. Otherwise, on the 2025
revision with the operator's opt-in, a write can come back as `{ error:
"confirmation_required", summary, confirmToken }`: show the summary to the
user and, only if they agree, repeat the identical call with `confirmToken`
added (it works once and expires; an error of "confirmation_invalid" means start over). The escape hatch returns JSON only (binary media is refused with a
pointer to `drive_download` / `drive_export`), and a response over about
100k characters may be cut by the client, so narrow a large request. Prefer
a named curated or generated tool when one exists: it is more token-lean
and better typed than building the call by hand.

## 8. Files: local server or hosted server

Where the server runs decides how bytes reach Drive. Check once per session
which of these tools `drive_discover` and `gmail_discover` list.

**A server on the user's own machine** (stdio, the default install) may read
and write files inside its local-files folder: `drive_upload` with
`localPath` or `localDir`, `drive_download`, `drive_export` with `savePath`,
and `gmail_download_attachment`. Paths are paths on that machine, confined to
the folder named in the tool's description.

**A hosted server** cannot touch any disk you can see, so none of those local
path arguments exist and `drive_download` and `gmail_download_attachment` are
absent. A call that sends `localPath` is rejected with a pointer to this
section. Do not look for a way around it; pick the tool for the job:

- A file already in Drive, or one that arrived as an email attachment: keep it
  server side. `gmail_attachment_to_drive` saves a message attachment into a
  Drive folder (take `messageId` and `attachmentId` from `gmail_read`).
  `drive_copy` with `convertTo` (`document`, `spreadsheet`, `presentation` or
  `drawing`) turns a Word, Excel, PowerPoint, CSV, text, HTML, Markdown, PDF
  or image file already in Drive into a native, editable Google file with no
  download or upload (`ocrLanguage` helps with scans). `drive_transfer` and
  `drive_transfer_stream` move a file between two linked accounts.
- A Google Doc, Sheet or Slides file that must leave as a PDF or Office file:
  `drive_export` saves the export as a new Drive file instead of a local file;
  `drive_attach_to_draft` mails it as a draft attachment.
- A file that only exists on the person's computer, or that the person wants
  on their computer: `file_transfer_create`. It returns a one-time link:
  direction `upload` (into a Drive folder) or `download` (one Drive file).
  Hand the `url` to the person to open in a browser, or, from a program that
  can send web requests, use the `upload` or `download` block it returns. A
  link works once and expires within minutes, so create it when the person is
  ready and never log it. `file_transfer_list` and `file_transfer_revoke`
  show and cancel open links. If it answers that file links are off for this
  account, say so and stop; the operator turns them on.
- Small content you already hold as text or base64: `drive_upload` with
  `contentBase64` (or `docs_create` plus `docs_insert_text`) needs no link.
- Folders and archives: `drive_zip` and `drive_unzip` work on Drive ids
  where the operator enabled them; `drive_create_shortcut` shows one item in
  a second folder without a copy or a move.

Rules of thumb: prefer an id-to-id tool over anything that moves bytes through
the conversation; never paste file contents into a tool call to get around a
missing tool; if the tool you need is not listed, tell the user what is
missing rather than approximating it with `google_api_call`.

## 9. Google Classroom

With the Classroom scope bundles granted, the curated Classroom tools cover
the common teacher flow; the long tail (announcements, rosters, grading,
topics) stays under the generated `classroom_*` tools.

1. `classroom_list_courses` finds the `courseId` (active courses by default).
2. Read with `classroom_list_materials`, `classroom_list_coursework` and
   `classroom_list_submissions`. Drafts are hidden by default; pass `states`
   `DRAFT` to see them.
3. Create with `classroom_create_material` (resources, no grade) or
   `classroom_create_coursework` (assignment or question, optional points and
   due date). Both create a **DRAFT** unless `state` is `PUBLISHED`; a draft
   is invisible to students. Attach Drive files by id with `driveFileIds`
   (the file must already be in Drive; `shareMode` defaults to view only) and
   web addresses with `links`.
4. `classroom_publish` flips a draft to published, which notifies students.
   Show the user what will be published and publish only on their go.
