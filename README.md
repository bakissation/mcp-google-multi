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
| `TOKEN_STORE_PATH` | — | override the encrypted token dir (default: `~/.config/mcp-google-multi/tokens`) |

Inspect the resolved setup any time: `mcp-google-multi config check`.

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

Maintainer-led. Direction is tracked publicly as **[GitHub Milestones](https://github.com/bakissation/mcp-google-multi/milestones)** (discover-first tooling → exhaustive API coverage → service accounts + hosting in v6). Not accepting unsolicited feature PRs; bug reports are welcome.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and the [Code of Conduct](./CODE_OF_CONDUCT.md). Security issues go to [SECURITY.md](./SECURITY.md), never a public issue.

## Credits

Built and maintained by **Abdelbaki Berkati** — [berkati.xyz](https://berkati.xyz) · [@bakissation](https://github.com/bakissation). [Read the case study →](https://berkati.xyz/case-studies/mcp-google-multi/)

Development is **funded by [IdeaCrafters](https://ideacrafters.com)** ([@IdeaCraftersHQ](https://github.com/IdeaCraftersHQ)) — the studio that pays for this OSS to exist.

## License

[MIT](./LICENSE)
