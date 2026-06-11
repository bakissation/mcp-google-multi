# mcp-google-multi

A **local** [MCP](https://modelcontextprotocol.io) server that gives Claude Code (and any MCP client) access to your **Google Workspace** — Gmail, Drive, Calendar, Sheets, Docs, Contacts, Tasks, Meet, Search Console (plus optional Forms, Chat, and Workspace Admin) — across **multiple Google accounts** at once.

[![npm](https://img.shields.io/npm/v/mcp-google-multi?label=npm&color=cb3837)](https://www.npmjs.com/package/mcp-google-multi)

> Open-source and **funded by [IdeaCrafters](https://github.com/IdeaCraftersHQ)** — the studio that pays for its development and upkeep.

- 🔑 **Multi-account** — drive any number of your Google accounts from one server, each by a short alias.
- 🔒 **Secure by default** — refresh tokens **encrypted at rest** (AES-256-GCM); **writes are deny-by-default**; no telemetry — it talks only to Google.
- 📦 **npm-first** — install and run with `npx`; everything configured through env vars.
- 🧰 **~170 tools** across 12 services → full list in **[COVERAGE.md](./COVERAGE.md)**.

> v5 is **local + user-OAuth only**. Service accounts and hosting (and the APIs they unlock) are on the [roadmap](https://github.com/bakissation/mcp-google-multi/milestones). **Upgrading from v4?** Jump to [Upgrading](#upgrading-from-v4).

## Quick start

You need **Node 20+**, a Google Cloud OAuth client (~2 min — [setup below](#google-cloud-setup)), and a random 32-byte key.

```bash
# 1) install
npm i -g mcp-google-multi

# 2) put your config + creds in the environment (see "Configuration").
#    Easiest for a quick try — export them, or drop a .env in your working dir:
#    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_ACCOUNTS, MASTER_KEY, GOOGLE_PROFILE

# 3) authenticate each account (opens a browser; one-time per account)
mcp-google-multi auth --account work
mcp-google-multi auth --account personal

# 4) register with Claude Code
claude mcp add google-multi -s user -- npx -y mcp-google-multi
```

Restart your MCP client and the tools appear. Tokens are written **encrypted** to `~/.config/mcp-google-multi/tokens/` (override with `TOKEN_STORE_PATH`) — useless to anyone without your `MASTER_KEY`.

Generate a key: `openssl rand -base64 32`.

## Recommended: keep secrets in a vault (Infisical)

A plaintext `.env` is fine to try it out, but for a daily driver, **don't leave `GOOGLE_CLIENT_SECRET` + `MASTER_KEY` on disk** — inject them at launch from a secrets manager. The server just reads `process.env` (it has no idea where the values come from), so wrap it with [Infisical](https://infisical.com):

```bash
#!/usr/bin/env bash
# ~/.local/bin/mcp-google-multi-run  — chmod +x, then register this as the MCP command
set -euo pipefail
export INFISICAL_TOKEN="$(infisical login --method=universal-auth \
  --client-id "$YOUR_CLIENT_ID" --client-secret "$YOUR_CLIENT_SECRET" --plain --silent)"
exec infisical run --projectId <project> --env prod --path /mcp-google-multi \
  -- npx -y mcp-google-multi
```

```bash
claude mcp add google-multi -s user -- ~/.local/bin/mcp-google-multi-run
```

Now the only thing on disk is the **encrypted** token store. Pass the token via the `INFISICAL_TOKEN` env var (as above), **not** a `--token` flag, so it never shows up in `ps`. (Any secrets manager works — Doppler, Vault, 1Password CLI, etc. — the pattern is the same.)

## Configuration

| Env var | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | ✓ | OAuth **Desktop** client from Google Cloud |
| `GOOGLE_ACCOUNTS` | ✓ | `alias:email,…` — e.g. `work:you@co.com,personal:you@gmail.com` |
| `MASTER_KEY` | ✓ | base64 32-byte key that encrypts the token store (`openssl rand -base64 32`) |
| `GOOGLE_PROFILE` | — | write policy: `read-only` (default) · `safe-writes` · `full-writes` |
| `GOOGLE_READ_ONLY` | — | `true` = hard kill-switch for all writes |
| `GOOGLE_WRITE_ALLOW` / `GOOGLE_WRITE_DENY` | — | glob overrides, e.g. `calendar:*`, `*:delete*` |
| `GOOGLE_OPTIONAL_SCOPES` | — | extra bundles: `forms`, `chat` |
| `GOOGLE_ADMIN_ACCOUNTS` | — | aliases granted Workspace-admin scopes (the account's own super-admin OAuth) |
| `GOOGLE_TOOLSETS` | — | `all` (default) or a CSV filter of: `gmail`, `drive`, `calendar`, `sheets`, `docs`, `contacts`, `searchconsole`, `tasks`, `meet`, `forms`, `chat`, `admin` |
| `TOKEN_STORE_PATH` | — | override the encrypted token dir (default: `~/.config/mcp-google-multi/tokens`) |
| `DISCOVERY_CACHE_PATH` | — | override the Discovery-doc cache dir (default: `~/.config/mcp-google-multi/discovery`) |
| `GOOGLE_TRIM` | — | `off` (or `0`/`false`/`no`) disables compact JSON serialization of tool responses |

Inspect the resolved setup any time: `mcp-google-multi config check`.

## Discover-first tools (tiny idle context)

The server does **not** dump ~170 tool schemas into your model's context. At boot, `tools/list` exposes only one small `{service}_discover` tool per service (plus nothing else). Calling e.g. `drive_discover` returns that service's operation catalog (name, one-line summary, arguments, read/write class), reveals the operational tools, and emits `notifications/tools/list_changed` so the client re-fetches the list. An optional `query` argument filters the catalog.

Hidden is a listing concept, not a security boundary: operational tools stay callable at all times (existing prompts that call tools directly keep working), and write-control + OAuth scopes remain the real enforcement. Use `GOOGLE_TOOLSETS` to switch entire services off — it is a filter only: listing `forms`/`chat`/`admin` does not enable them without their `GOOGLE_OPTIONAL_SCOPES` / `GOOGLE_ADMIN_ACCOUNTS` gates.

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

Two eager tools cover everything the curated set doesn't: `google_api_search` finds any method in Google's API Discovery index (including APIs with no dedicated tools here, like Slides), and `google_api_call` invokes a method by its Discovery id (`drive.revisions.list`, `slides.presentations.create`, …) with path/query params and a JSON body. Calls run through your account's OAuth client and the **same write-control policy** as named tools: the read/create/update/delete class is derived from the method's HTTP verb and name (POST deletes like `batchDelete`/`clear` count as deletes), and policy globs/`GOOGLE_TOOLSETS` match the same service names as named tools (`people` counts as `contacts`, `admin_*` as `admin`; `slides`/`driveactivity`/`drivelabels`/`groupssettings` have no named service and are always available).

Discovery documents are fetched from Google on first use and cached on disk for 7 days (`DISCOVERY_CACHE_PATH`, default `~/.config/mcp-google-multi/discovery`); a stale cache is used when offline.

## Lean responses by default

Tool responses are serialized compactly (no pretty-print token tax; set `GOOGLE_TRIM=off` to restore pretty JSON), and the fat readers ship sensible caps with per-call escape valves. The caps are per-call controls (`full` / `maxChars`) and are NOT affected by `GOOGLE_TRIM`:

- `drive_read` returns up to `maxChars` characters (default 100k) with `truncated`/`totalChars`/`offset` for paging — this also bounds Google Doc exports, which can reach 10MB. (Non-Google-native files over 2MB are still rejected with `too_large`, not paged.)
- `gmail_read` / `gmail_read_thread` cap each message body at 50k chars (`bodyTruncated` + `bodyTotalChars` flags); pass `full: true` for the whole body.
- `calendar_list_events` / `calendar_list_instances` trim descriptions to ~300 chars and drop empty/audit fields (`created`/`updated`) in list view; `calendar_get_event` always returns the full event.

## Write-control (deny-by-default)

Reads are never gated. **Every create/update/delete is off until you opt in** — pick a profile:

| `GOOGLE_PROFILE` | Allows |
|---|---|
| `read-only` (default) | reads only |
| `safe-writes` | create + update (deletes still blocked) |
| `full-writes` | everything |

`GOOGLE_READ_ONLY=true` overrides all. For fine control: `GOOGLE_WRITE_ALLOW="calendar:*, sheets:update*"` and `GOOGLE_WRITE_DENY="*:delete*"` (deny wins). `mcp-google-multi config check` prints the resolved policy and exactly which tools are enabled.

## What's covered

~170 tools across Gmail, Drive, Calendar, Sheets, Docs, Contacts, Search Console, Tasks, Meet, and (optional) Forms, Chat, Workspace Admin. **Full per-tool list → [COVERAGE.md](./COVERAGE.md).** Every tool takes an `account` argument matching one of your aliases.

## Google Cloud setup

1. [Google Cloud Console](https://console.cloud.google.com) → create or select a project.
2. Enable the APIs you'll use: Gmail, Drive, Calendar, Sheets, Docs, People, Search Console, Tasks, Meet (+ Forms / Chat / Admin SDK if you enable those bundles).
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID → Desktop app**.
4. Add the redirect URI `http://localhost:4242/oauth2callback`.
5. Copy the **Client ID** + **Client Secret** into your environment.

## Upgrading from v4

v5 is a breaking change, but the migration is a one-time, ~2-minute step:

1. Update: `npm i -g mcp-google-multi@latest` (or update your client config).
2. Add **`MASTER_KEY`** to your environment (`openssl rand -base64 32`) — now required.
3. Encrypt existing tokens: `mcp-google-multi migrate-tokens` (reads your old `tokens/<alias>/token.json` and encrypts them) — or just re-auth each account.
4. Writes are now **deny-by-default** — set `GOOGLE_PROFILE=safe-writes` (or `full-writes`) to keep writing. (`GOOGLE_ALLOW_ADMIN_WRITES` is gone — replaced by write-control profiles.)

## Security

Your OAuth, your machine. Refresh tokens are **AES-256-GCM encrypted at rest** (decryptable only with your `MASTER_KEY`), writes are deny-by-default, and the server has **no telemetry** — it connects only to Google's APIs. Found a vulnerability? Report it privately — see [SECURITY.md](./SECURITY.md), never a public issue.

## Roadmap

Maintainer-led. Direction is tracked publicly as **[GitHub Milestones](https://github.com/bakissation/mcp-google-multi/milestones)** (exhaustive API coverage → service accounts + hosting in v6). Not accepting unsolicited feature PRs; bug reports are welcome.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and the [Code of Conduct](./CODE_OF_CONDUCT.md). Security issues go to [SECURITY.md](./SECURITY.md), never a public issue.

## Credits

Built and maintained by **Abdelbaki Berkati** — [berkati.xyz](https://berkati.xyz) · [@bakissation](https://github.com/bakissation). [Read the case study →](https://berkati.xyz/case-studies/mcp-google-multi/)

Development is **funded by [IdeaCrafters](https://ideacrafters.com)** ([@IdeaCraftersHQ](https://github.com/IdeaCraftersHQ)) — the studio that pays for this OSS to exist.

## License

[MIT](./LICENSE)
