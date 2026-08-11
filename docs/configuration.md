# Configuration reference

Everything is configured through environment variables and an optional `${XDG_CONFIG_HOME:-~/.config}/mcp-google-multi/config.json`. `.env` files load automatically with this precedence (highest first): real environment, then `.env` in the working directory, then `.env` in the package root, then `${XDG_CONFIG_HOME:-~/.config}/mcp-google-multi/.env`. Set `MCP_GOOGLE_MULTI_ENV=/abs/path/.env` to load exactly that file instead of searching; a missing or unreadable pointed file is a fatal `E_ENV_NOT_FOUND`. Node.js 22+ is required; older runtimes exit with `E_NODE_TOO_OLD`. Back to the [README](../README.md).

## config.json (account registry)

Accounts live in a mutable, plaintext-by-design `config.json` (no secrets ever; safe to commit):

```jsonc
{
  "version": 1,
  "accounts": {
    "work":     { "email": "you@company.com", "admin": true },
    "personal": { "email": "you@gmail.com" }
  }
}
```

- **Env override:** while `GOOGLE_ACCOUNTS` is set and non-empty, the whole registry comes from env and the file is ignored (12-factor deployments keep working unchanged). `GOOGLE_ADMIN_ACCOUNTS`, when set, overrides per-account `admin` flags.
- **`mcp-google-multi migrate-config`** synthesizes the file from your current env (idempotent; never edits env).
- On first start with `GOOGLE_ACCOUNTS` set and no file, the file is materialized automatically.
- Secrets (`GOOGLE_CLIENT_ID`/`SECRET`, `MASTER_KEY`) are never config fields — a secret-shaped key fails validation (`E_CONFIG_INVALID`).
- Startup errors: no accounts anywhere = `E_NO_ACCOUNTS_CONFIGURED`; invalid file = `E_CONFIG_INVALID`; a file written by a newer version = `E_CONFIG_VERSION_UNSUPPORTED` (upgrade the package).

## Scope profiles (per-account consent)

Each account can point at a named **scope profile** so consent is exactly what that account uses — a Workspace account can carry admin + `gmail_settings` while a personal account is never asked for them:

```jsonc
{
  "version": 1,
  "accounts": {
    "work":     { "email": "you@company.com", "scopeProfile": "workspace-admin" },
    "personal": { "email": "you@gmail.com" }
  },
  "scopeProfiles": {
    "workspace-admin": { "bundles": ["gmail_settings", "chat"], "admin": true }
  }
}
```

- A missing `scopeProfile` means the built-in `base` profile (base scopes only). `admin: true` on a profile equals including the `admin` bundle.
- Services register for the **union** of every account's bundles; authorization stays per account at call time (an account without the bundle gets a scope error with a re-auth hint, not silent access).
- Changing a profile changes that account's consent set — re-run `auth --account <alias>` for it.
- An unknown bundle name fails startup with `E_UNKNOWN_BUNDLE` and a did-you-mean suggestion (v5 silently ignored typos).
- `GOOGLE_OPTIONAL_SCOPES` still works as a legacy global override applied to every account (warns `E_LEGACY_GLOBAL_SCOPES`; `migrate-config` folds it into an explicit `legacy-global` profile).

### Bundle catalog

| Bundle | Risk | Unlocks |
|---|---|---|
| `slides` | low | Create and edit Slides presentations |
| `keep` | low | Read and edit Keep notes |
| `driveactivity` | low | Read the Drive activity feed |
| `postmaster` | low | Read Postmaster Tools deliverability data |
| `forms` | medium | Build Forms and read responses |
| `chat` | medium | Read/send Chat messages, manage spaces |
| `gmail_settings` | medium | Mailbox settings: filters, labels, vacation |
| `classroom` | medium | Courses, coursework, rosters, announcements |
| `cloudsearch` | medium | Query Cloud Search across Workspace content |
| `drivelabels` | medium | Manage Drive labels |
| `script` | medium | Apps Script projects and deployments |
| `groupssettings` | medium | Google Groups settings |
| `gmail_settings_sharing` | high | Forwarding/delegation — can route mail out |
| `cloudidentity` | high | Cloud Identity groups and devices |
| `groupsmigration` | high | Migrate messages into Groups |
| `licensing` | high | Assign/revoke license seats |
| `reseller` | high | Reseller subscriptions and orders |
| `appsmarket` | high | Marketplace license assignments |
| `vault` | high (Workspace-only) | eDiscovery over the whole domain |
| `admin` | high (Workspace-only) | Directory management + audit reports |

## Environment variables

| Env var | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | ✓ | OAuth **Desktop** client from Google Cloud — see [Google Cloud setup](./google-cloud-setup.md) |
| `GOOGLE_ACCOUNTS` | ✓ | `alias:email,…` — e.g. `work:you@co.com,personal:you@gmail.com` |
| `GOOGLE_DEFAULT_ACCOUNT` | | Alias used when a tool call omits `account` (or set `"defaultAccount"` in config.json; env wins; note: while `GOOGLE_ACCOUNTS` is set, the whole registry — including the default — comes from env, so the config field is inert). Unset = `account` stays required per call (`E_NO_DEFAULT_ACCOUNT` hint on omission). Explicit aliases, `*` and CSV are never affected |
| `GOOGLE_DISCOVERY` | | Tool-surface visibility: `lazy` (default — meta-tools only until `{service}_discover`), `curated` (~200 curated tools advertised eagerly), `eager` (everything). At runtime an agent can `discover_all` / `discover_reset` to expand/collapse a lazy surface without config changes |
| `MASTER_KEY` | | encrypts the token store. Optional since v6: auto-provisioned as env > OS keychain > `master.key` (0600) > generated-on-setup. Keep it in env for deployments that may downgrade or move hosts. Never regenerated while encrypted tokens exist (`E_MASTER_KEY_MISSING_TOKENS_EXIST`) |
| `GOOGLE_PROFILE` | — | write policy: `read-only` (default) · `safe-writes` · `full-writes` |
| `GOOGLE_READ_ONLY` | — | `true` = hard kill-switch for all writes |
| `GOOGLE_WRITE_ALLOW` / `GOOGLE_WRITE_DENY` | — | glob overrides, e.g. `calendar:*`, `*:delete*` (deny wins) |
| `GOOGLE_OPTIONAL_SCOPES` | — | opt-in scope bundles, CSV — see [bundles](#optional-scope-bundles) |
| `GOOGLE_ADMIN_ACCOUNTS` | — | aliases granted Workspace-admin scopes (the account's own super-admin OAuth) |
| `GOOGLE_TOOLSETS` | — | `all` (default) or a CSV filter of service names — see [services](#services) |
| `TOKEN_STORE_PATH` | — | override the encrypted token dir (default: `$XDG_CONFIG_HOME/mcp-google-multi/tokens`, falling back to `~/.config/mcp-google-multi/tokens`) |
| `DISCOVERY_CACHE_PATH` | — | override the Discovery-doc cache dir (default: `$XDG_CONFIG_HOME/mcp-google-multi/discovery`, falling back to `~/.config/mcp-google-multi/discovery`) |
| `GOOGLE_TRIM` | — | `off` (or `0`/`false`/`no`) disables compact JSON serialization of tool responses |

Inspect the resolved setup any time: `mcp-google-multi config check`.

## Transport

By default the server speaks **stdio** (`MCP_TRANSPORT=stdio`), the zero-network local transport every example uses. It can also serve **Streamable HTTP** for MCP clients that connect over a URL.

| Variable | Default | Notes |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio`, `http`, or `both` |
| `MCP_HTTP_HOST` | `127.0.0.1` | bind address (loopback) |
| `MCP_HTTP_PORT` | `4243` | bind port |
| `MCP_PUBLIC_URL` | `http://<host>:<port>` | the canonical public base URL; `${MCP_PUBLIC_URL}/mcp` is the endpoint clients connect to |
| `MCP_OWNER_EMAILS` | — | required for `http`: the Google email(s) allowed to authenticate |
| `MCP_ALLOWED_ORIGINS` | — | extra Origins to allow beyond `MCP_PUBLIC_URL` and `https://claude.ai` |

> **HTTP is currently loopback-only.** Until the built-in OAuth authorization server ships, the server refuses to start any exposed HTTP shape (a non-loopback bind, or a non-loopback `MCP_PUBLIC_URL` — i.e. a tunnel/reverse proxy in front). Loopback callers are trusted as the owner, the same trust model as stdio, so do not run HTTP mode on a shared host. Register the local URL with your client using `mcp-google-multi write-client-config --url http://127.0.0.1:4243/mcp`.

## Write-control (deny-by-default)

Reads are never gated. **Every create/update/delete is off until you opt in** — pick a profile:

| `GOOGLE_PROFILE` | Allows |
|---|---|
| `read-only` (default) | reads only |
| `safe-writes` | create + update (deletes still blocked) |
| `full-writes` | everything |

`GOOGLE_READ_ONLY=true` overrides all. For fine control: `GOOGLE_WRITE_ALLOW="calendar:*, sheets:update*"` and `GOOGLE_WRITE_DENY="*:delete*"` (deny wins). The policy applies identically to curated tools, generated tools, and the escape hatch.

## Services

Core services register by default: `gmail`, `drive`, `calendar`, `sheets`, `docs`, `contacts`, `searchconsole`, `tasks`, `meet`, `workspaceevents`.

Optional services register when their bundle is enabled (below): `slides`, `forms`, `chat`, `classroom`, `cloudidentity`, `cloudsearch`, `vault`, `keep`, `driveactivity`, `drivelabels`, `script`, `postmaster`, `groupssettings`, `groupsmigration`, `licensing`, `reseller`, `appsmarket` — plus `admin`, which requires `GOOGLE_ADMIN_ACCOUNTS`.

`GOOGLE_TOOLSETS` is a filter only: listing an optional service does not enable it without its bundle/admin gate.

## Optional scope bundles

Add bundle names to `GOOGLE_OPTIONAL_SCOPES` (CSV), then re-run `auth` for each account so the new scopes are granted:

`slides`, `forms`, `chat`, `classroom`, `cloudidentity`, `cloudsearch`, `vault`, `keep`, `driveactivity`, `drivelabels`, `script`, `postmaster`, `groupssettings`, `groupsmigration`, `licensing`, `reseller`, `appsmarket`.

Two bundles extend the always-on `gmail` service instead of enabling a new one — Gmail settings **writes** only accept the dedicated settings scopes (reads already work with the base scope):

| Bundle | Scope | Unlocks |
|---|---|---|
| `gmail_settings` | `gmail.settings.basic` | writing filters, vacation responder, IMAP/POP, language |
| `gmail_settings_sharing` | `gmail.settings.sharing` | send-as, delegates, auto-forwarding — kept separate because it can redirect or delegate your mail |

A tool whose scope was never granted returns a typed `insufficient_scope` error with a re-auth hint instead of failing silently.

## Secrets management

Don't leave `GOOGLE_CLIENT_SECRET` + `MASTER_KEY` in a plaintext `.env` for daily use — inject them at launch from a secrets manager. See [Secrets in a vault](./secrets.md).
