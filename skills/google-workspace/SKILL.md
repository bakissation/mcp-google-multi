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
instead. The escape hatch returns JSON only (binary media is refused with a
pointer to `drive_download` / `drive_export`), and a response over about
100k characters may be cut by the client, so narrow a large request. Prefer
a named curated or generated tool when one exists: it is more token-lean
and better typed than building the call by hand.
