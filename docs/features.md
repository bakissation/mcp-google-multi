# Features tour

How the server keeps 942 tools usable, fast, and safe. Back to the [README](../README.md).

## Discover-first tools (tiny idle context)

The server does **not** dump hundreds of tool schemas into your model's context. At boot (default `GOOGLE_DISCOVERY=lazy`), `tools/list` exposes only one small `{service}_discover` tool per service plus the escape hatch, `account_list`, `diagnose`, the account tools (`account_add`, `account_reauth`, `account_write_config`), and the `discover_all`/`discover_reset` pair — an agent can expand the whole curated layer at once for heavy Google work and collapse it after to reclaim context. `GOOGLE_DISCOVERY=curated` advertises all curated tools eagerly (generated long tail still deferred); `eager` advertises everything. Over HTTP the mode is always `curated` (a stateless transport cannot push `tools/list_changed`). Calling e.g. `drive_discover` returns that service's operation catalog (name, one-line summary, arguments, read/write class), reveals the operational tools, and emits `notifications/tools/list_changed` so the client re-fetches the list. An optional `query` argument filters the catalog.

Hidden is a listing concept, not a security boundary: operational tools stay callable at all times (existing prompts that call tools directly keep working), and write-control + OAuth scopes remain the real enforcement. Use `GOOGLE_TOOLSETS` to switch entire services off — it is a filter only: listing an optional service does not enable it without its scope-profile bundle (or legacy `GOOGLE_OPTIONAL_SCOPES`) / admin gate.

## Curated + generated tiers

Everyday operations are **curated** tools: hand-written, response-shaped, token-lean. The long tail is **generated** from Google's API Discovery documents — one tool per method, same write-control, same account fan-out, regenerated when Google revises an API. Together they cover every OAuth-reachable Workspace API method: 942 tools (191 curated + 751 generated) across 29 services. A default install (no optional bundles, no admin account) registers 336 tools across 10 services; generated tools whose scopes no bundle can grant are not advertised, which puts the reachable ceiling at 732. The split per service is in [COVERAGE.md](../COVERAGE.md).

Every tool advertises MCP annotations computed from its read/create/update/delete class: reads are `readOnlyHint: true`, and every write (creates and sends included) is `destructiveHint: true`, so clients that key per-call approval on annotations ask before running it. Tools that are read-classified for write-control but still write something (`google_api_call`, the account tools, the download/export tools that save to disk) advertise as writes too.

## Multi-account: fan out one call across accounts

Every read tool's `account` argument also accepts `"*"` (all configured accounts) or a CSV subset (`"work,personal"`). The server runs the call once per account (bounded concurrency) and returns per-account results — one account failing never hides the others:

```jsonc
{ "results": [
    { "account": "work", "ok": true, "data": { /* … */ } },
    { "account": "personal", "ok": false, "error": { "error": "auth_required", /* … */ } }
  ],
  "partial": true }
```

Fan-out is **read-only by design** (write tools take exactly one account), and the three read tools that save files to disk (`drive_download`, `drive_export`, `gmail_download_attachment`) are excluded so parallel accounts can't clobber the same path. `account_list` is terse by default: alias, email, admin flag, token status (`ok` / `expired_refreshable` / `needs_reauth` / `missing` / `decrypt_error`), and which one is the default, without ever touching token values. Pass `verbose: true` for the full per-account report, granted-vs-configured scopes included.

`drive_transfer` copies or moves a file between two of your accounts: server-side share+copy when possible (the temporary read grant on the source is revoked right after; the copy gets a clean name, never "Copy of"), download+upload as the fallback. `move: true` trashes the source after a successful copy; that part is **delete-gated by write-control**, so `safe-writes` can copy but never move. (Note: `safe-writes` allows `gmail_trash`, `drive_trash`, and `gmail_users_threads_trash` to move items to Trash, which can be recovered; only permanent deletes are refused.) Comments, revision history, and permissions don't transfer; if the fallback has to change the format (Drawings export as PNG), the result is flagged `lossy` and a requested move keeps the source intact. Native files over Google's 10MB export cap and binaries over 1GB can't take the fallback path. The fallback internally calls `files.create`/`files.copy`/`files.update` and `permissions.create`/`permissions.delete`, so `GOOGLE_WRITE_DENY="drive:transfer"` also blocks `google_api_call` on those raw Discovery methods directly, not only on `drive_transfer` itself.

## Escape hatch: any Workspace REST method

Two eager tools cover anything outside the snapshot: `google_api_search` finds any method of the 32 supported Workspace API Discovery documents, and `google_api_call` invokes a method by its Discovery id (`drive.revisions.list`, `slides.presentations.create`, …) with path/query params and a JSON body. Calls run through your account's OAuth client and the **same write-control policy** as named tools (note: the per-call human-approval prompt that honoring clients show on the handful of irreversible named tools — real sends, permanent deletes — does not cover escape-hatch calls; server-side write-control is their only gate): the read/create/update/delete class is derived from the method's HTTP verb and name (POST deletes like `batchDelete`/`clear` count as deletes), and policy globs/`GOOGLE_TOOLSETS` match the same service names as named tools (`people` counts as `contacts`, `admin_*` as `admin`). Responses are JSON only: binary media (`alt=media` downloads, `drive.files.export`) is refused up front with a typed `binary_unsupported` error pointing to `drive_download` / `drive_export`, and a JSON response over 100k characters comes back as `{truncated, totalChars, head}` plus a hint to narrow the request (fields mask, `pageSize`). Generated tools run through the same executor, so the same cap and binary refusal apply to them.

Discovery documents are fetched from Google on first use and cached on disk for 7 days (`DISCOVERY_CACHE_PATH`); a stale cache is used when offline.

## Outbound recipient allowlist (off by default)

For unattended or agent-driven deployments, `GOOGLE_OUTBOUND_ALLOWLIST` (comma-separated addresses and `@domain` suffixes) constrains WHO the server can mail, invite or grant access to: Gmail recipients (reply-derived ones included), Calendar attendees/ACL grantees, and Drive permission grantees, enforced across curated tools, generated tools and the escape hatch. On the generic (generated-tool / escape-hatch) path this covers both the plain `emailAddress`/`email` keys any Discovery body can carry, and the resource-scoped shapes a plain key walk cannot see: a Drive permission's `type`/`domain` (`anyone` link sharing refused outright; `domain` needs an exact `@domain` entry), a Calendar ACL's `scope.type`/`scope.value` (`default`, i.e. public, refused the same way), and Gmail `delegateEmail` / `forwardingEmail` / `sendAsEmail` / a filter's `action.forward`. A write to one of those methods whose body does not match a shape the check understands is refused rather than let through unexamined. `drive_permission_update` looks the existing permission up itself (its own body never carries the grantee), so it refuses every change to a permission whose grantee is `anyone`/an unlisted domain, including a role **downgrade** that would make the permission less powerful. Escape-hatch raw-compose methods (whose base64 message cannot be inspected) are refused with a hint pointing at the curated, enforced path. It is a prompt-injection blast-radius control: a hijacked agent cannot exfiltrate to arbitrary targets. Blocked calls fail with a typed `recipient_not_allowed` envelope naming the target and the active list. Unset by default: nothing is gated.

## Lean responses by default

Tool responses are serialized compactly (no pretty-print token tax; set `GOOGLE_TRIM=off` to restore pretty JSON), and the fat readers ship sensible caps with per-call escape valves. The caps are per-call controls (`full` / `maxChars`) and are NOT affected by `GOOGLE_TRIM`:

- `drive_read` returns up to `maxChars` characters (default 100k) with `truncated`/`totalChars`/`offset` for paging — this also bounds Google Doc exports, which can reach 10MB. (Non-Google-native files over 2MB are still rejected with `too_large`, not paged.) Textual coverage goes beyond `text/*`: RFC 6839 structured-syntax suffixes (`image/svg+xml`, `application/ld+json`, …) and the bare structured types (`application/json`, `application/xml`, …) inline too; everything else returns `error: "binary"` with a pointer to `drive_download`/`drive_export`.
- `gmail_read` / `gmail_read_thread` cap each message body at 50k chars (`bodyTruncated` + `bodyTotalChars` flags); pass `full: true` for the whole body. Pass `headers` on `gmail_read` (or `gmail_read_batch`) to skip body decoding entirely and get back only `id`, `threadId`, `labelIds` and the named header values.
- `gmail_read_batch` reads up to 100 message ids in one call (collapsing the search→read triage loop): one ordered entry per id (`{ id, ...message }` or `{ id, error }`) plus a trailing `{ counts: { ok, failed }, truncated? }` summary. A single failed id does not fail the batch (auth/scope failures do); per-message bodies are capped at 50k (unless `full: true`) and the aggregate output is bounded so a large batch never blows the context window.
- `calendar_list_events` / `calendar_list_instances` trim descriptions to ~300 chars and drop empty/audit fields in list view; `calendar_get_event` always returns the full event.

**A capped list says so.** `drive_search`, `drive_list`, `calendar_list_events`, `calendar_list_instances`, `contacts_search` and `contacts_group_members` return `{ "<noun>": [...], returned, truncated }` rather than a bare array, plus `nextPageToken` / `totalItems` / `hint` when the API supplies them. A bare array cannot distinguish "these are all your events" from "these are the first 25 of them", so an agent reports the cap as the answer and has no way to notice. The four tools whose Google endpoints offer a continuation token also accept `pageToken`; `contacts_search` and `contacts_group_members` have none to offer, so they report truncation and point at the page-size control instead.


### Email attachments & safe compose

`gmail_send` and `gmail_create_draft` share one MIME builder (nodemailer MailComposer) and accept `attachments: [{ path, filename?, contentType? }]` — the server reads each absolute path itself (MailComposer never touches the filesystem or network), refuses files inside its own config/token directory, caps the whole message at Gmail's ~25 MB limit once encoded (`E_ATTACHMENT_TOO_LARGE`), and derives the MIME filename by basename. Address/subject headers containing CR/LF are rejected up front (`E_HEADER_INJECTION`); bodies are CRLF-normalized and base64-encoded so Gmail's raw upload can't be corrupted by a bare LF.

### Host-file access: one policy, an off switch

Every tool that touches the machine's disk (Gmail attachments, Drive `localPath`/`savePath` on `drive_upload`/`drive_update`/`drive_download`/`drive_export`/`gmail_download_attachment`) shares one policy (`assertLocalPathAllowed`, `src/tools/_local-files.ts`): the path must resolve, after symlinks (including a symlinked ancestor directory of a path that does not exist yet), inside `GOOGLE_LOCAL_FILES_DIR` (default `~/Downloads/mcp-google-multi`, created on first use with mode `0700`). A relative path or filename resolves inside that root; an absolute one must already be inside it; a path escaping it, directly or through a symlink, is refused. On top of the root, as defense in depth for a root configured too wide (e.g. `$HOME`), the server's own config/token directory (`master.key`, `tokens/*.enc`, `mcp-tokens.enc`), the Discovery cache directory, `/proc` (which includes `/proc/self/environ`), and any `.env` file the server actually loaded a secret from stay refused regardless of where they fall relative to the root. A download never silently overwrites a file already at the destination, and a failed download cleans up its own partial file so a retry is not refused with `local_path_exists`. These tools and params are owner-only to begin with (never offered to a non-owner HTTP session); set `GOOGLE_LOCAL_FILES=off` to remove them even from the owner, e.g. for a deployment that should never touch the host filesystem at all.


### Markdown email (send)

`gmail_send` / `gmail_create_draft` take `body` as **Markdown**: the server renders it to HTML once and sends `multipart/alternative` where the Markdown source is the `text/plain` part and the rendered HTML is the `text/html` part. Raw HTML in `body` is escaped by default (XSS-safe); pass `allowRawHtml: true` for literal HTML such as inline color. `htmlBody` is not accepted — passing it errors (`E_HTMLBODY_REMOVED`) with the rewrite. Note: plain prose containing Markdown metacharacters (`#`, `*`, `_`, `>`, backticks, `[..]()`) renders as Markdown.


### Markdown email (read)

`gmail_read` / `gmail_read_thread` return a `bodyFormat` discriminator on every message so the model knows how to read `body`:

- `plain` — a `text/plain` part existed (or the message had no body). `body` is that part verbatim. Plain parts always win over an HTML alternative.
- `markdown` — the message was **HTML-only**; the server converts it to Markdown (headings, links, lists, GFM tables/strikethrough) so structure survives instead of collapsing to a flat text dump. The 50k body cap applies to the converted Markdown, not the source HTML.
- `html` — you passed `rawHtml: true` and the message was HTML-only; `body` is the unconverted source HTML.

Script/style/head content is dropped during conversion (never leaked into `body`); if conversion fails the server falls back to plain-text extraction and reports `bodyFormat: 'plain'`.


### Reply auto-fill

Set `replyToMessageId` on `gmail_send` / `gmail_create_draft` and the server derives the reply for you from the source message in a single fetch — no separate `gmail_read` first:

- `to` ← the source `From` (or the source `To` when you're replying to your own sent mail).
- `subject` ← the source `Subject`, prefixed `Re: ` unless it already carries one (never double-prefixed).
- `cc` ← only with `replyAll: true`: the source `To` + `Cc` minus your own addresses (primary + Gmail send-as aliases) minus the `to` recipient.
- `In-Reply-To` / `References` threading headers.

Any value you pass explicitly wins over the derived one (`to`, `cc`, `subject` are optional when `replyToMessageId` is set). If the source can't be fetched: with a caller `to`, the send proceeds with threading degraded to the message id; without a `to`, the call fails `not_found` rather than sending to nobody. A failed send-as lookup degrades the own-address set to your primary and never blocks the send.


### Contact resolver

`contacts_resolve` turns a free-text name into **one canonical email**, so an agent stops hand-expanding transliterations (`Zoe OR Zoë OR Zoey`) into `contacts_search` OR-queries. It searches saved contacts (and, by default, auto-saved "other contacts" you've emailed) and applies a deterministic tie-break: exact name (accent-folded) over prefix, saved over other-contact, primary/`work` email over the rest, fuller record over bare. It returns one confident `{ resolved: { name, email, resourceName, source } }`, an explicit `{ ambiguous: true, candidates: [...] }` when a real tie survives, or `{ resolved: null }` for no match (never an error). A missing "other contacts" scope degrades to saved contacts only.


## Health check: `doctor` & `diagnose`

`mcp-google-multi doctor` gives a sectioned, exit-coded health report (models `brew doctor`): **Runtime** (Node ≥ 22), **Config** (config.json + legacy env/`.env` detection with the exact `migrate-config`/`mv` fix), **Keys** (`MASTER_KEY` provenance; a brick — unprovisioned key with encrypted tokens present — is a hard fail pointing at `reset`), **Tokens** (per-account status), **Scopes** (three-state granted-vs-profile), **API enablement** (a live read probe on the first healthy account), and **HTTP** (only when `MCP_TRANSPORT` includes `http`: config, owner gate, and a live self-fetch of the OAuth metadata endpoints). Every warn/fail carries a copy-pasteable remediation; it is strictly read-only (no mutation). Exit is non-zero on any FAIL (`--strict` also fails on WARN), so `doctor` can gate CI and migration scripts. Flags: `--json` (machine-readable on stdout), `--strict`, `--report` (a redacted, paste-ready bug report that masks email local-parts and never includes token values or keys).

The same engine is exposed to agents as the read-only **`diagnose`** tool, returning the structured report so an agent can self-diagnose an auth/config failure and surface the fix.

## Local usage metrics (off by default)

Operator-enabled, **local-only** usage aggregates (tool names, error classes, latency buckets; never arguments, payloads, or identities) with **zero network egress ever**: no endpoint, no beacon, no push; data leaves the machine only when the operator copies files. Off until `GOOGLE_USAGE_METRICS=on`, self-announcing when on (boot log, `doctor`, `diagnose` name the state and its source), read locally with `mcp-google-multi metrics report`. The file format, structural guarantees at their true scope, the promotion workflow and the operator responsibility note live in [usage-metrics.md](./usage-metrics.md).

`mcp-google-multi reset` recovers a bricked or stale install: it wipes encrypted token files (all accounts, or `--account <alias>`) — **config.json is always kept** — and with `--regenerate-key` also drops the generated `MASTER_KEY` (refused while any account still holds a token, since a fresh key would brick it). It is confirmation-gated (`--yes` for non-interactive) and, after a wipe, prints the exact re-auth command per account.


## Interactive account management: `account_add` / `account_reauth`

Two always-visible, human-approved tools (`anthropic/requiresUserInteraction`) manage accounts on a running server, with no file editing and no restart for the account itself:

- **`account_add`** collects the account (alias, email, scope-bundle checkboxes incl. an "all optional scopes" option, and a Workspace-admin toggle) via an elicitation **form**, writes the registry through the atomic path, then runs Google consent in the browser (URL-mode elicitation, or a printed link as a fallback). The new alias is callable immediately. Tools of a service the account enables for the first time (a new `forms` bundle, say) register when the server starts, so they appear after a restart; the result says so, and `google_api_call` reaches that API meanwhile. When the server can't reach the granted scopes you asked for (granular consent), it reports `E_SCOPE_NOT_GRANTED` naming what to re-grant. If accounts are pinned via the legacy `GOOGLE_ACCOUNTS` env, `account_add` refuses with `E_ENV_ACCOUNTS_MODE` (config.json is ignored while that env is set); migrate with `mcp-google-multi migrate-config` to use it.
- **`account_reauth <alias>`** re-runs consent for an existing account: recover a dead refresh token (e.g. one expired by an OAuth app still in Testing mode) or grant scopes after a profile change. It works regardless of how the account was defined, and like `account_add` it says when a service the change enables needs a restart for its tools.

On stdio both run the loopback consent flow (your own OAuth client), so tokens never leave your machine. Over HTTP they return a consent link that completes at the server's own `/callback`.

### Move a setup to another machine: `account export` / `account import`

`mcp-google-multi account export --out bundle.enc` packs your registry (`config.json` accounts + scope profiles) and every encrypted `<alias>.enc` token file into a single bundle, encrypted under a **passphrase** you choose (set `MCP_TRANSFER_PASSPHRASE` or you'll be prompted). Secrets like `MASTER_KEY` and your client secret are never in the bundle.

`mcp-google-multi account import bundle.enc` decrypts it and **merges** the accounts into the target's registry — new aliases are added, and an alias that already exists is skipped (never clobbering local tokens) unless you pass `--replace`. It reports what was added, replaced and skipped, then points you at `doctor` to check token health.

The bundled token files stay encrypted under the **source** machine's `MASTER_KEY`, so set the same `MASTER_KEY` on the target to use them (otherwise re-authenticate with `account_reauth`). If `GOOGLE_ACCOUNTS` is set on the target, the imported `config.json` registry is ignored until you unset it.

- **`account_write_config`** registers this server with your MCP client so you don't hand-edit JSON. It detects Claude Code, Claude Desktop, and Cursor, then returns the exact entry to add — a `claude mcp add …` command for Claude Code, or an `mcpServers` JSON snippet for the file-based clients. Pass `write:true` to write the detected file configs in place; it backs the file up first, updates any existing entry rather than duplicating, and refuses to clobber a malformed config (it prints the snippet instead). Secrets are never inlined — the server loads its own `.env`, so the entry carries none. The same flow is available on the CLI: `mcp-google-multi write-client-config [--client claude-code|claude-desktop|cursor] [--name <server-name>] [--url <https://…/mcp>] [--print] [--yes]` (prints instead of writing when non-interactive or `--print`).

## Remote access over HTTP (built-in OAuth)

Set `MCP_TRANSPORT=http` and the server becomes its own **OAuth 2.1 authorization server**, so Claude Code's native `/mcp` authenticate flow and the claude.ai custom connector work with zero custom UI. A connecting client is sent through Google login; only an email in `MCP_OWNER_EMAILS` (the owner gate) is admitted, and the server then mints its own short-lived, audience-bound token for the client. The two credential families never cross: your per-account Google tokens are never handed to the client, and a client token is never presented to Google (federate-and-hold). It advertises PRM + AS metadata (`S256` PKCE, no JWKS — the server is its own resource server), federates via CIMD (`MCP_CIMD_ALLOWED_ISSUERS`, default `claude.ai`) with a minimal DCR fallback, SSRF-guards every metadata fetch, and rotates refresh tokens. Behind a Cloudflare named tunnel keep the bind on loopback and set `MCP_PUBLIC_URL` to the public HTTPS host. See [configuration.md](./configuration.md#transport) for the keys, or [http-setup.md](./http-setup.md) for the full named-tunnel, Docker, and one-click Render/Railway walkthrough.
