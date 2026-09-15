# Features tour

How the server keeps 874 tools usable, fast, and safe. Back to the [README](../README.md).

## Discover-first tools (tiny idle context)

The server does **not** dump hundreds of tool schemas into your model's context. At boot (default `GOOGLE_DISCOVERY=lazy`), `tools/list` exposes only one small `{service}_discover` tool per service plus the escape hatch, `account_list`, and the `discover_all`/`discover_reset` pair — an agent can expand the whole curated layer at once for heavy Google work and collapse it after to reclaim context. `GOOGLE_DISCOVERY=curated` advertises all curated tools eagerly (generated long tail still deferred); `eager` advertises everything. Calling e.g. `drive_discover` returns that service's operation catalog (name, one-line summary, arguments, read/write class), reveals the operational tools, and emits `notifications/tools/list_changed` so the client re-fetches the list. An optional `query` argument filters the catalog.

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

Two eager tools cover anything outside the snapshot: `google_api_search` finds any method of the 28 supported Workspace APIs in Google's API Discovery index, and `google_api_call` invokes a method by its Discovery id (`drive.revisions.list`, `slides.presentations.create`, …) with path/query params and a JSON body. Calls run through your account's OAuth client and the **same write-control policy** as named tools (note: the per-call human-approval prompt that honoring clients show on the handful of irreversible named tools — real sends, permanent deletes — does not cover escape-hatch calls; server-side write-control is their only gate): the read/create/update/delete class is derived from the method's HTTP verb and name (POST deletes like `batchDelete`/`clear` count as deletes), and policy globs/`GOOGLE_TOOLSETS` match the same service names as named tools (`people` counts as `contacts`, `admin_*` as `admin`). Responses are JSON only: binary media (`alt=media` downloads, `drive.files.export`) is refused up front with a typed `binary_unsupported` error pointing to `drive_download` / `drive_export`, and a JSON response over 100k characters comes back as `{truncated, totalChars, head}` plus a hint to narrow the request (fields mask, `pageSize`). Generated tools run through the same executor, so the same cap and binary refusal apply to them.

Discovery documents are fetched from Google on first use and cached on disk for 7 days (`DISCOVERY_CACHE_PATH`); a stale cache is used when offline.

## Lean responses by default

Tool responses are serialized compactly (no pretty-print token tax; set `GOOGLE_TRIM=off` to restore pretty JSON), and the fat readers ship sensible caps with per-call escape valves. The caps are per-call controls (`full` / `maxChars`) and are NOT affected by `GOOGLE_TRIM`:

- `drive_read` returns up to `maxChars` characters (default 100k) with `truncated`/`totalChars`/`offset` for paging — this also bounds Google Doc exports, which can reach 10MB. (Non-Google-native files over 2MB are still rejected with `too_large`, not paged.)
- `gmail_read` / `gmail_read_thread` cap each message body at 50k chars (`bodyTruncated` + `bodyTotalChars` flags); pass `full: true` for the whole body.
- `gmail_read_batch` reads up to 100 message ids in one call (collapsing the search→read triage loop): one ordered entry per id (`{ id, ...message }` or `{ id, error }`) plus a trailing `{ counts: { ok, failed }, truncated? }` summary. A single failed id does not fail the batch (auth/scope failures do); per-message bodies are capped at 50k (unless `full: true`) and the aggregate output is bounded so a large batch never blows the context window.
- `calendar_list_events` / `calendar_list_instances` trim descriptions to ~300 chars and drop empty/audit fields in list view; `calendar_get_event` always returns the full event.


### Email attachments & safe compose

`gmail_send` and `gmail_create_draft` share one MIME builder (nodemailer MailComposer) and accept `attachments: [{ path, filename?, contentType? }]` — the server reads each absolute path itself (MailComposer never touches the filesystem or network), caps the total at ~35 MB, and derives the MIME filename by basename. Address/subject headers containing CR/LF are rejected up front (`E_HEADER_INJECTION`), closing the old header-injection hole; bodies are CRLF-normalized and base64-encoded so Gmail's raw upload can't be corrupted by a bare LF.


### Markdown email (send)

`gmail_send` / `gmail_create_draft` take `body` as **Markdown**: the server renders it to HTML once and sends `multipart/alternative` where the Markdown source is the `text/plain` part and the rendered HTML is the `text/html` part. Raw HTML in `body` is escaped by default (XSS-safe); pass `allowRawHtml: true` for literal HTML such as inline color. `htmlBody` is removed — passing it errors (`E_HTMLBODY_REMOVED`) with the rewrite. Note: plain prose containing Markdown metacharacters (`#`, `*`, `_`, `>`, backticks, `[..]()`) now renders as Markdown.


### Markdown email (read)

`gmail_read` / `gmail_read_thread` return a `bodyFormat` discriminator on every message so the model knows how to read `body`:

- `plain` — a `text/plain` part existed (or the message had no body). `body` is that part verbatim, byte-identical to v5. Plain parts always win over an HTML alternative.
- `markdown` — the message was **HTML-only**; the server converts it to Markdown (headings, links, lists, GFM tables/strikethrough) so structure survives instead of collapsing to a flat text dump. The 50k body cap applies to the converted Markdown, not the source HTML.
- `html` — you passed `rawHtml: true` and the message was HTML-only; `body` is the unconverted source HTML.

Script/style/head content is dropped during conversion (never leaked into `body`); if conversion fails the server falls back to plain-text extraction and reports `bodyFormat: 'plain'`.


### Reply auto-fill

Set `replyToMessageId` on `gmail_send` / `gmail_create_draft` and the server derives the reply for you from the source message in a single fetch — no separate `gmail_read` first:

- `to` ← the source `From` (or the source `To` when you're replying to your own sent mail).
- `subject` ← the source `Subject`, prefixed `Re: ` unless it already carries one (never double-prefixed).
- `cc` ← only with `replyAll: true`: the source `To` + `Cc` minus your own addresses (primary + Gmail send-as aliases) minus the `to` recipient.
- `In-Reply-To` / `References` threading headers as before.

Any value you pass explicitly wins over the derived one (`to`, `cc`, `subject` are now optional when `replyToMessageId` is set). If the source can't be fetched: with a caller `to`, the send proceeds with threading degraded to the message id; without a `to`, the call fails `not_found` rather than sending to nobody. A failed send-as lookup degrades the own-address set to your primary and never blocks the send.


### Contact resolver

`contacts_resolve` turns a free-text name into **one canonical email**, so an agent stops hand-expanding transliterations (`Rym OR Rim OR Reem`) into `contacts_search` OR-queries. It searches saved contacts (and, by default, auto-saved "other contacts" you've emailed) and applies a deterministic tie-break: exact name (accent-folded) over prefix, saved over other-contact, primary/`work` email over the rest, fuller record over bare. It returns one confident `{ resolved: { name, email, resourceName, source } }`, an explicit `{ ambiguous: true, candidates: [...] }` when a real tie survives, or `{ resolved: null }` for no match (never an error). A missing "other contacts" scope degrades to saved contacts only.


## Health check: `doctor` & `diagnose`

`mcp-google-multi doctor` gives a sectioned, exit-coded health report (models `brew doctor`): **Runtime** (Node ≥ 22), **Config** (config.json + legacy env/`.env` detection with the exact `migrate-config`/`mv` fix), **Keys** (`MASTER_KEY` provenance; a brick — unprovisioned key with encrypted tokens present — is a hard fail pointing at `reset`), **Tokens** (per-account status), **Scopes** (three-state granted-vs-profile), and **API enablement**. Every warn/fail carries a copy-pasteable remediation; it is strictly read-only (no mutation). Exit is non-zero on any FAIL (`--strict` also fails on WARN), so `doctor` can gate CI and migration scripts. Flags: `--json` (machine-readable on stdout), `--strict`, `--report` (a redacted, paste-ready bug report that masks email local-parts and never includes token values or keys).

The same engine is exposed to agents as the read-only **`diagnose`** tool, returning the structured report so an agent can self-diagnose an auth/config failure and surface the fix. (HTTP-transport checks and the live per-service API-enablement probe land with the OAuth authorization server.)

`mcp-google-multi reset` recovers a bricked or stale install: it wipes encrypted token files (all accounts, or `--account <alias>`) — **config.json is always kept** — and with `--regenerate-key` also drops the generated `MASTER_KEY` (refused while any account still holds a token, since a fresh key would brick it). It is confirmation-gated (`--yes` for non-interactive) and, after a wipe, prints the exact re-auth command per account.


## Interactive account management: `account_add` / `account_reauth`

Two always-visible, human-approved tools (`anthropic/requiresUserInteraction`) manage accounts on a running server — no file editing, no restart:

- **`account_add`** collects the account (alias, email, scope-bundle checkboxes incl. an "all optional scopes" option, and a Workspace-admin toggle) via an elicitation **form**, writes the registry through the atomic path, then runs Google consent in the browser (URL-mode elicitation, or a printed link as a fallback). The new alias is callable immediately. When the server can't reach the granted scopes you asked for (granular consent), it reports `E_SCOPE_NOT_GRANTED` naming what to re-grant. If accounts are pinned via the legacy `GOOGLE_ACCOUNTS` env, `account_add` refuses with `E_ENV_ACCOUNTS_MODE` (config.json is ignored while that env is set) — migrate with `mcp-google-multi migrate-config` to use it.
- **`account_reauth <alias>`** re-runs consent for an existing account: recover a dead refresh token (the 7-day-trap fix) or grant scopes after a profile change. It works regardless of how the account was defined.

Both reuse the loopback consent flow (your own OAuth client), so tokens never leave your machine. (HTTP-transport consent lands with the OAuth authorization server.)

### Move a setup to another machine: `account export` / `account import`

`mcp-google-multi account export --out bundle.enc` packs your registry (`config.json` accounts + scope profiles) and every encrypted `<alias>.enc` token file into a single bundle, encrypted under a **passphrase** you choose (set `MCP_TRANSFER_PASSPHRASE` or you'll be prompted). Secrets like `MASTER_KEY` and your client secret are never in the bundle.

`mcp-google-multi account import bundle.enc` decrypts it and **merges** the accounts into the target's registry — new aliases are added, and an alias that already exists is skipped (never clobbering local tokens) unless you pass `--replace`. It backs the choice on collision, then points you at `doctor` to check token health.

Two caveats: the bundled token files stay encrypted under the **source** machine's `MASTER_KEY`, so set the same `MASTER_KEY` on the target to use them (otherwise re-authenticate with `account_reauth`); and the target must already have at least one account configured (the server won't start with an empty registry), so configure the target first, then import to bring the rest.

- **`account_write_config`** registers this server with your MCP client so you don't hand-edit JSON. It detects Claude Code, Claude Desktop, and Cursor, then returns the exact entry to add — a `claude mcp add …` command for Claude Code, or an `mcpServers` JSON snippet for the file-based clients. Pass `write:true` to write the detected file configs in place; it backs the file up first, updates any existing entry rather than duplicating, and refuses to clobber a malformed config (it prints the snippet instead). Secrets are never inlined — the server loads its own `.env`, so the entry carries none. The same flow is available on the CLI: `mcp-google-multi write-client-config [--client claude-code|claude-desktop|cursor] [--url <https://…/mcp>] [--print] [--yes]` (prints instead of writing when non-interactive or `--print`).

## Remote access over HTTP (built-in OAuth)

Set `MCP_TRANSPORT=http` and the server becomes its own **OAuth 2.1 authorization server**, so Claude Code's native `/mcp` authenticate flow and the claude.ai custom connector work with zero custom UI. A connecting client is sent through Google login; only an email in `MCP_OWNER_EMAILS` (the owner gate) is admitted, and the server then mints its own short-lived, audience-bound token for the client. The two credential families never cross: your per-account Google tokens are never handed to the client, and a client token is never presented to Google (federate-and-hold). It advertises PRM + AS metadata (`S256` PKCE, no JWKS — the server is its own resource server), federates via CIMD (`MCP_CIMD_ALLOWED_ISSUERS`, default `claude.ai`) with a minimal DCR fallback, SSRF-guards every metadata fetch, and rotates refresh tokens. Behind a Cloudflare named tunnel keep the bind on loopback and set `MCP_PUBLIC_URL` to the public HTTPS host. See [configuration.md](./configuration.md#transport) for the keys, or [http-setup.md](./http-setup.md) for the full named-tunnel, Docker, and one-click Render/Railway walkthrough.
