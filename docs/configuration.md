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
- An unknown bundle name fails startup with `E_UNKNOWN_BUNDLE` and a did-you-mean suggestion.
- `"includesBase": false` on a profile drops the base scopes (advanced; a profile that resolves to zero scopes fails `E_CONFIG_INVALID`).
- `GOOGLE_OPTIONAL_SCOPES` still works as a legacy global override applied to every account (warns `E_LEGACY_GLOBAL_SCOPES`; `migrate-config` folds it into an explicit `legacy-global` profile).

### Bundle catalog

| Bundle | Risk | Unlocks |
|---|---|---|
| `slides` | low | Create and edit Slides presentations |
| `keep` | low | Read and edit Keep notes (not for a personal account) |
| `driveactivity` | low | Read the Drive activity feed |
| `postmaster` | low | Read Postmaster Tools deliverability data |
| `analytics` | low | Read Google Analytics (GA4): reports, realtime, account/property config |
| `analytics_write` | medium | Edit GA4 configuration: properties, streams, key events, custom definitions (includes read) |
| `forms` | medium | Build Forms and read responses |
| `chat` | medium | Read/send Chat messages, manage spaces |
| `gmail_settings` | medium | Mailbox settings: filters, labels, vacation |
| `classroom` | medium | Courses, coursework, rosters, announcements |
| `cloudsearch` | medium | Query Cloud Search across Workspace content |
| `drivelabels` | medium | Manage Drive labels |
| `script` | medium | Apps Script projects and deployments |
| `groupssettings` | medium | Google Groups settings |
| `gmail_settings_sharing` | high | Forwarding/delegation — can route mail out |
| `cloudidentity` | high | Cloud Identity groups and devices (not for a personal account) |
| `groupsmigration` | high | Migrate messages into Groups |
| `licensing` | high | Assign/revoke license seats |
| `reseller` | high | Reseller subscriptions and orders |
| `appsmarket` | high | Marketplace license assignments |
| `vault` | high (Workspace-only) | eDiscovery over the whole domain |
| `admin` | high (Workspace-only) | Directory management + audit reports |

Google refuses the `keep` and `cloudidentity` scopes on a personal account's consent screen, and the refusal fails the whole sign-in. So for a `gmail.com` or `googlemail.com` address, `allBundles` leaves both out, and naming either one is refused with `E_VALIDATION`.

## Environment variables

| Env var | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | ✓ | OAuth **Desktop** client from Google Cloud — see [Google Cloud setup](./google-cloud-setup.md) |
| `GOOGLE_ACCOUNTS` | — | `alias:email,…` — e.g. `work:you@co.com,personal:you@gmail.com`. When set and non-empty it replaces the `config.json` registry; one of the two must define at least one account |
| `GOOGLE_DEFAULT_ACCOUNT` | | Alias used when a tool call omits `account` (or set `"defaultAccount"` in config.json; env wins; note: while `GOOGLE_ACCOUNTS` is set, the whole registry — including the default — comes from env, so the config field is inert). Unset = `account` stays required per call (`E_NO_DEFAULT_ACCOUNT` hint on omission). An alias that is not configured fails startup with `E_DEFAULT_ACCOUNT_UNKNOWN`. Explicit aliases, `*` and CSV are never affected |
| `GOOGLE_DISCOVERY` | | Tool-surface visibility: `lazy` (default — meta-tools only until `{service}_discover`), `curated` (all 191 curated tools advertised eagerly), `eager` (everything). An invalid value warns and falls back to `lazy`; over HTTP the mode is always `curated`. At runtime an agent can `discover_all` / `discover_reset` to expand/collapse a lazy surface without config changes |
| `MASTER_KEY` | | encrypts the token store. Optional: resolved as env > OS keychain > `master.key` (0600, in the config dir) > generated on first use. Keep it in env for deployments that may downgrade or move hosts. Never regenerated while encrypted tokens exist (`E_MASTER_KEY_MISSING_TOKENS_EXIST`) |
| `GOOGLE_PROFILE` | — | write policy: `read-only` (default) · `safe-writes` · `full-writes`; an invalid value warns and falls back to `read-only` |
| `GOOGLE_READ_ONLY` | — | `true` (or `1`/`yes`) = hard kill-switch for all writes |
| `GOOGLE_WRITE_ALLOW` / `GOOGLE_WRITE_DENY` | — | glob overrides, e.g. `calendar:*`, `*:delete*` (deny wins) |
| `GOOGLE_OPTIONAL_SCOPES` | — | legacy: CSV of scope bundles applied to every account (warns `E_LEGACY_GLOBAL_SCOPES`; prefer [scope profiles](#scope-profiles-per-account-consent)) — see [bundles](#optional-scope-bundles) |
| `GOOGLE_ADMIN_ACCOUNTS` | — | aliases granted Workspace-admin scopes (the account's own super-admin OAuth); when set, overrides per-account `admin` flags |
| `GOOGLE_TOOLSETS` | — | `all` (default) or a CSV filter of service names; unknown names warn and are ignored — see [services](#services) |
| `GOOGLE_LOCAL_FILES` | on | `off` (or `0`/`false`/`no`, any case; an unrecognised value warns and stays "on") removes every host-file tool/param (Gmail attachments, Drive `localPath`/`savePath`, `drive_download`, `drive_export`, `gmail_download_attachment`) even from the owner session that would otherwise get them. These are already owner-only and share one confinement policy, see [features.md](./features.md#host-file-access-one-policy-an-off-switch) |
| `GOOGLE_LOCAL_FILES_DIR` | `~/Downloads/mcp-google-multi` | the allow-list root every host-file read and write must resolve inside (realpath, so a symlink cannot escape it); a relative path or filename resolves inside this root. Created on first use (mode `0700`) if missing. The server's own config/token directory, Discovery cache, `/proc`, and any `.env` file it loaded secrets from stay refused even when they fall inside a root set too wide (e.g. `$HOME`) |
| `TOKEN_STORE_PATH` | — | override the encrypted token dir (default: `$XDG_CONFIG_HOME/mcp-google-multi/tokens`, falling back to `~/.config/mcp-google-multi/tokens`) |
| `DISCOVERY_CACHE_PATH` | — | override the Discovery-doc cache dir (default: `$XDG_CONFIG_HOME/mcp-google-multi/discovery`, falling back to `~/.config/mcp-google-multi/discovery`) |
| `GOOGLE_ARG_UNKNOWN` | `reject` | what to do with a `tools/call` argument the tool does not declare: `reject` (default) refuses the call with a typed `unknown_argument` error naming the likely intended parameter, `warn` logs it to stderr and drops it, `off` drops it silently. A bad value falls back to `warn`, not to the default. Never screened: keys starting with `_`, keys containing `/`, the client artifacts `random_string`/`toolCallId`/`tool_call_id`/`tool_call_description`, tools that declare no arguments, and a key whose declared twin the same call also sent |
| `GOOGLE_OUTBOUND_ALLOWLIST` | off | opt-in outbound target allowlist for unattended deployments: comma-separated addresses and `@domain` suffixes gating Gmail recipients, Calendar attendees/ACL grantees and Drive permission grantees, across curated tools, generated tools and the escape hatch. On the escape hatch / generated path, every `emailAddress`/`email` key anywhere in the body is checked, plus method-aware rules for the grantee shapes that key walk cannot see: a Drive permission's `type`/`domain` (`anyone` always refused, `domain` needs an exact `@domain` entry), a Calendar ACL's `scope.type`/`scope.value` (`default` refused like `anyone`), and Gmail `delegateEmail` / `forwardingEmail` / `sendAsEmail` / filter `action.forward`. While active, a write to one of those grantee-bearing methods whose body does not match a shape it understands is refused rather than let through unexamined; uninspectable raw-compose methods and `drive_share` `anyone` link shares are refused outright. `drive_permission_update`'s body never carries the grantee at all (only role/expiration), so it looks the existing permission up and checks ITS type/domain/email instead: this means it refuses every change to a permission whose grantee is `anyone`/an unlisted domain while the allowlist is active, including a role **downgrade** (e.g. writer to reader) that would make the permission less powerful, not just an upgrade. Blocked calls fail with `recipient_not_allowed` and a hint |
| `GOOGLE_USAGE_METRICS` | off | local usage metrics: `on\|1\|true\|yes` enables, `off\|0\|false\|no` disables; any other value warns and stays OFF; wins over the `usageMetrics` config key. See [usage-metrics.md](./usage-metrics.md) |
| `usageMetrics` (config.json) | absent = off | same switch as a config key; remove it before downgrading below 6.0 (strict schema) |
| `USAGE_METRICS_PATH` | — | override the metrics dir (default: `$XDG_STATE_HOME/mcp-google-multi/metrics`, falling back to `~/.local/state/mcp-google-multi/metrics`); setting the path alone enables nothing |
| `GOOGLE_TRIM` | — | `off` (or `0`/`false`/`no`) disables compact JSON serialization of tool responses |
| `GOOGLE_ARG_NORMALIZE` | — | `off` (or `0`/`false`/`no`) disables tools/call argument-key normalization (snake_case → declared camelCase when unambiguous; each rename logs one line to stderr) |
| `MCP_GOOGLE_MULTI_ENV` | — | absolute path of the one `.env` file to load instead of searching (see top of page) |
| `MCP_TRANSFER_PASSPHRASE` | — | passphrase for `account export` / `account import`; unset = prompt on a TTY |

Inspect the resolved setup any time: `mcp-google-multi config check`.

## Transport

By default the server speaks **stdio** (`MCP_TRANSPORT=stdio`), the zero-network local transport every example uses. It can also serve **Streamable HTTP** for MCP clients that connect over a URL.

| Variable | Default | Notes |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio`, `http`, or `both` |
| `MCP_HTTP_HOST` | `127.0.0.1` | bind address |
| `MCP_HTTP_PORT` | `4243` | bind port |
| `MCP_PUBLIC_URL` | `http://<host>:<port>` | the canonical public base URL; `${MCP_PUBLIC_URL}/mcp` is the endpoint clients connect to |
| `MCP_OWNER_EMAILS` | *(required for http)* | CSV of Google emails allowed to authenticate; the server refuses to start HTTP without it |
| `MCP_ALLOWED_ORIGINS` | — | extra Origins to allow beyond `MCP_PUBLIC_URL` and `https://claude.ai` |
| `MCP_CIMD_ALLOWED_ISSUERS` | `claude.ai` | CSV host allowlist for OAuth client-metadata documents. Other clients that pick CIMD are refused with `invalid_client` until their host is listed, e.g. `claude.ai,chatgpt.com` for Codex or ChatGPT |
| `MCP_ACCESS_TTL` | `600` | MCP access-token lifetime (seconds) |
| `MCP_JWT_KEY` | auto | signing key for the server's own MCP tokens; resolved like `MASTER_KEY` (env > OS keychain > `mcp-jwt.key` file > generated). Regenerating it only signs clients out |

Over HTTP the server is its own **OAuth 2.1 authorization server**: Claude Code and the claude.ai connector authenticate with zero custom UI. A client that connects to `${MCP_PUBLIC_URL}/mcp` is sent through Google login; only an email in `MCP_OWNER_EMAILS` is admitted (the owner gate), and the server then mints its own audience-bound token for the client — your Google tokens are never handed to the client, and the client's token is never sent to Google. Behind a Cloudflare named tunnel, keep the bind on loopback and set `MCP_PUBLIC_URL` to the public HTTPS host; add `${MCP_PUBLIC_URL}/callback` as an authorized redirect URI in your Google Cloud console. Register the URL with a local client via `mcp-google-multi write-client-config --url ${MCP_PUBLIC_URL}/mcp`. Full remote-HTTP walkthrough — named tunnel, Docker, and one-click Render/Railway deploys — is in [docs/http-setup.md](./http-setup.md).

### Docker

A distroless, non-root image is provided (`Dockerfile`). Build and run it, passing secrets at runtime (never baked into the image):

```sh
docker build -t mcp-google-multi .
docker run --init --rm \
  -e GOOGLE_CLIENT_ID -e GOOGLE_CLIENT_SECRET \
  -e GOOGLE_ACCOUNTS="work:me@company.example,personal:me@gmail.example" \
  -e MASTER_KEY \
  -e MCP_OWNER_EMAILS="me@company.example" \
  -v mcp-config:/home/nonroot/.config/mcp-google-multi \
  mcp-google-multi
```

`-e NAME` with no value passes the variable through from your shell; set `MASTER_KEY` once (e.g. `openssl rand -base64 32`) and keep reusing it. `--init` forwards SIGTERM for a clean shutdown. Persist the config volume across restarts — the OS keychain is unavailable in distroless, so without `MASTER_KEY` in env the key is generated into a `0600` file on that volume, and a regenerated key would brick existing tokens. The image defaults to `MCP_TRANSPORT=http` bound to loopback; the full tunnel/remote recipe (including `cloudflared` + compose wiring and the Render/Railway deploy buttons) is in [docs/http-setup.md](./http-setup.md).

## Write-control (deny-by-default)

Reads are never gated. **Every create/update/delete is off until you opt in** — pick a profile:

| `GOOGLE_PROFILE` | Allows |
|---|---|
| `read-only` (default) | reads only |
| `safe-writes` | create + update on your own data, plus moving items to or from Trash (permanent deletes and privileged writes blocked) |
| `full-writes` | everything |

`GOOGLE_READ_ONLY=true` overrides all; an invalid `GOOGLE_PROFILE` falls back to `read-only`. For fine control: `GOOGLE_WRITE_ALLOW="calendar:*, sheets:update*"` and `GOOGLE_WRITE_DENY="*:delete*"` (deny wins). Each tool matches as `service:cud` and as `service:op` (its name minus the service prefix), so a tool named after its own class shares that class's pattern: `drive:update` matches `drive_update` and every other update-class Drive tool (`drive_move`, `drive_permission_update`, …). The policy applies identically to curated tools, generated tools, and the escape hatch: `google_api_call` resolves the Discovery method to the real tool's name when one exists (curated or generated), and is also checked under the full method-path name (`drive_permissions_create`, `gmail_users_settings_filters_create`) and the legacy last-dot-segment name, so a resource-scoped method can never collapse onto a generic `drive_create`/`gmail_create` that a resource-scoped deny pattern cannot match. Denying any one of those names denies the call. A curated tool's own deny reaches every raw Discovery method it calls internally, not just its own primary one: `drive_transfer`'s download+upload fallback also calls `files.create`/`files.copy`/`files.update` and `permissions.create`/`permissions.delete` (see `CURATED_METHOD_TOOLS`), so `GOOGLE_WRITE_DENY="drive:transfer"` also blocks `google_api_call` on those raw methods, not only on `drive_transfer` itself. One exception to the `service:cud` meaning: a push-channel registration (any `*_watch`/`*_subscriptions_create` tool) needs the real op name (`gmail:users_watch`) or a true service wildcard (`gmail:*`) to allow it; a bare `service:cud` allow (`gmail:create`) no longer does, since every other create/update-class tool in that service would otherwise also open it. Deny is unaffected: `gmail:create` still blocks it, same as before.

### What `safe-writes` refuses beyond deletes

"Not a delete" is a statement about an HTTP verb, not about consequences. `safe-writes` also refuses two classes of write that are shaped like an ordinary create or update:

- **Privileged scope.** The method can be authorized by a scope that acts on the whole organization, on legal holds, on billing, or on deployed code: `admin.directory.*`, `admin.datatransfer`, `cloud-identity*`, `apps.licensing`, `apps.order`, `apps.groups.settings`, `apps.groups.migration`, `ediscovery*` (Vault), `script.projects`, `script.deployments`. This is what stops `admin_users_make_admin` and `admin_two_step_verification_turn_off`, both of which are plain `update`s.
- **Push-channel registration.** Any `*_watch` method, plus `workspaceevents` subscription create and reactivate. These register a webhook that delivers your activity to an external URL, so they are exports wearing the shape of a create.

The rule is derived from each method's declared scopes and name, not from a hand-kept list, so it keeps working as the generated surface is regenerated. A method whose scopes are unknown is treated as **not** privileged: absent information is not evidence, and failing the other way would break ordinary writes.

`GOOGLE_WRITE_ALLOW` still wins over this, because naming a tool explicitly is a deliberate opt-in. `GOOGLE_WRITE_DENY` still wins over that.

### Trash is the one delete-shaped exception

`gmail_trash`, `drive_trash`, and Gmail's generated thread-level twin only move an item to Trash, which the Drive and Gmail UIs can still recover from; `safe-writes` allows them like any other non-privileged write. Untrashing was already a plain `update` and was never refused. Every other delete, including emptying Trash, a permanent Gmail or Drive delete, and `drive_transfer`'s `move` flag, stays refused under `safe-writes`.

In numbers, `safe-writes` permits 274 of 545 write tools instead of 385. It now also allows `gmail_trash`, `drive_trash`, and `gmail_users_threads_trash`, while still refusing every permanent delete, write with a privileged scope, and push-channel registration. No other `gmail`, `drive`, `calendar`, `docs`, `sheets`, `tasks` or `contacts` write is affected except the seven `*_watch` registrations.

## Services

Core services register by default: `gmail`, `drive`, `calendar`, `sheets`, `docs`, `contacts`, `searchconsole`, `tasks`, `meet`, `workspaceevents`.

Optional services register when their bundle is enabled (below): `slides`, `forms`, `chat`, `analytics` (or `analytics_write`), `classroom`, `cloudidentity`, `cloudsearch`, `vault`, `keep`, `driveactivity`, `drivelabels`, `script`, `postmaster`, `groupssettings`, `groupsmigration`, `licensing`, `reseller`, `appsmarket` — plus `admin`, which requires `GOOGLE_ADMIN_ACCOUNTS`.

`GOOGLE_TOOLSETS` is a filter only: listing an optional service does not enable it without its bundle/admin gate.

## Optional scope bundles

Add bundle names to an account's [scope profile](#scope-profiles-per-account-consent) (or, legacy, to `GOOGLE_OPTIONAL_SCOPES` as CSV for every account), then re-run `auth --account <alias>` so the new scopes are granted:

`slides`, `forms`, `chat`, `analytics`, `analytics_write`, `classroom`, `cloudidentity`, `cloudsearch`, `vault`, `keep`, `driveactivity`, `drivelabels`, `script`, `postmaster`, `groupssettings`, `groupsmigration`, `licensing`, `reseller`, `appsmarket`.

Two bundles extend the always-on `gmail` service instead of enabling a new one — Gmail settings **writes** only accept the dedicated settings scopes (reads already work with the base scope):

| Bundle | Scope | Unlocks |
|---|---|---|
| `gmail_settings` | `gmail.settings.basic` | writing filters, vacation responder, IMAP/POP, language |
| `gmail_settings_sharing` | `gmail.settings.sharing` | send-as, delegates, auto-forwarding — kept separate because it can redirect or delegate your mail |

A tool whose scope was never granted returns a typed `insufficient_scope` error with a re-auth hint instead of failing silently.

## Secrets management

Don't leave `GOOGLE_CLIENT_SECRET` + `MASTER_KEY` in a plaintext `.env` for daily use — inject them at launch from a secrets manager. See [Secrets in a vault](./secrets.md).
