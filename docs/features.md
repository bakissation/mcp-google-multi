# Features tour

How the server keeps 872 tools usable, fast, and safe. Back to the [README](../README.md).

## Discover-first tools (tiny idle context)

The server does **not** dump hundreds of tool schemas into your model's context. At boot, `tools/list` exposes only one small `{service}_discover` tool per service (plus the escape hatch and `account_list`). Calling e.g. `drive_discover` returns that service's operation catalog (name, one-line summary, arguments, read/write class), reveals the operational tools, and emits `notifications/tools/list_changed` so the client re-fetches the list. An optional `query` argument filters the catalog.

Hidden is a listing concept, not a security boundary: operational tools stay callable at all times (existing prompts that call tools directly keep working), and write-control + OAuth scopes remain the real enforcement. Use `GOOGLE_TOOLSETS` to switch entire services off — it is a filter only: listing an optional service does not enable it without its `GOOGLE_OPTIONAL_SCOPES` / `GOOGLE_ADMIN_ACCOUNTS` gate.

## Curated + generated tiers

Everyday operations are **curated** tools: hand-written, response-shaped, token-lean. The long tail is **generated** from Google's API Discovery documents — one tool per method, same write-control, same account fan-out, regenerated when Google revises an API. Together they cover every OAuth-reachable Workspace API method; the split per service is in [COVERAGE.md](../COVERAGE.md).

## Multi-account: fan out one call across accounts

Every read tool's `account` argument also accepts `"*"` (all configured accounts) or a CSV subset (`"work,personal"`). The server runs the call once per account (bounded concurrency) and returns per-account results — one account failing never hides the others:

```jsonc
{ "results": [
    { "account": "work", "ok": true, "data": { /* … */ } },
    { "account": "personal", "ok": false, "error": { "error": "auth_required", /* … */ } }
  ],
  "partial": true }
```

Fan-out is **read-only by design** (write tools take exactly one account), and the three read tools that save files to disk (`drive_download`, `drive_export`, `gmail_download_attachment`) are excluded so parallel accounts can't clobber the same path. `account_list` shows what's configured: alias, email, token health (`ok` / `expired_refreshable` / `needs_reauth` / `missing` / `decrypt_error`), and granted-vs-configured scopes — without ever touching token values.

`drive_transfer` copies or moves a file between two of your accounts: server-side share+copy when possible (the temporary read grant on the source is revoked right after; the copy gets a clean name, never "Copy of"), download+upload as the fallback. `move: true` trashes the source after a successful copy — that part is **delete-gated by write-control**, so `safe-writes` can copy but never move. Comments, revision history, and permissions don't transfer; if the fallback has to change the format (Drawings export as PNG), the result is flagged `lossy` and a requested move keeps the source intact. Native files over Google's 10MB export cap and binaries over 1GB can't take the fallback path.

## Escape hatch: any Workspace REST method

Two eager tools cover anything outside the snapshot: `google_api_search` finds any method of the 28 supported Workspace APIs in Google's API Discovery index, and `google_api_call` invokes a method by its Discovery id (`drive.revisions.list`, `slides.presentations.create`, …) with path/query params and a JSON body. Calls run through your account's OAuth client and the **same write-control policy** as named tools: the read/create/update/delete class is derived from the method's HTTP verb and name (POST deletes like `batchDelete`/`clear` count as deletes), and policy globs/`GOOGLE_TOOLSETS` match the same service names as named tools (`people` counts as `contacts`, `admin_*` as `admin`). Responses are JSON only: binary media (`alt=media` downloads, `drive.files.export`) is refused up front with a typed `binary_unsupported` error pointing to `drive_download` / `drive_export`, and a JSON response over 100k characters comes back as `{truncated, totalChars, head}` plus a hint to narrow the request (fields mask, `pageSize`). Generated tools run through the same executor, so the same cap and binary refusal apply to them.

Discovery documents are fetched from Google on first use and cached on disk for 7 days (`DISCOVERY_CACHE_PATH`); a stale cache is used when offline.

## Lean responses by default

Tool responses are serialized compactly (no pretty-print token tax; set `GOOGLE_TRIM=off` to restore pretty JSON), and the fat readers ship sensible caps with per-call escape valves. The caps are per-call controls (`full` / `maxChars`) and are NOT affected by `GOOGLE_TRIM`:

- `drive_read` returns up to `maxChars` characters (default 100k) with `truncated`/`totalChars`/`offset` for paging — this also bounds Google Doc exports, which can reach 10MB. (Non-Google-native files over 2MB are still rejected with `too_large`, not paged.)
- `gmail_read` / `gmail_read_thread` cap each message body at 50k chars (`bodyTruncated` + `bodyTotalChars` flags); pass `full: true` for the whole body.
- `calendar_list_events` / `calendar_list_instances` trim descriptions to ~300 chars and drop empty/audit fields in list view; `calendar_get_event` always returns the full event.
