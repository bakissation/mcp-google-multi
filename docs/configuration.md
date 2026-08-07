# Configuration reference

Everything is configured through environment variables (a `.env` in the working directory is loaded automatically). Back to the [README](../README.md).

## Environment variables

| Env var | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | ✓ | OAuth **Desktop** client from Google Cloud — see [Google Cloud setup](./google-cloud-setup.md) |
| `GOOGLE_ACCOUNTS` | ✓ | `alias:email,…` — e.g. `work:you@co.com,personal:you@gmail.com` |
| `MASTER_KEY` | ✓ | base64 32-byte key that encrypts the token store (`openssl rand -base64 32`) |
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
