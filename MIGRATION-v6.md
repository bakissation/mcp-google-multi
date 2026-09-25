# Migrating to v6 (`6.0.0`)

v6 is one big-bang major that batches every foreseeable breaking change so you migrate **once**. Most installs need **three edits and one re-auth**. The trust model is unchanged: you bring your own Google OAuth client, tokens stay encrypted on your disk, and writes are deny-by-default.

If you keep secrets and accounts in env vars for a server deployment, the short version is: **upgrade Node to 22, run `migrate-config`, run `doctor`, re-auth what it names.** Everything below is detail for the cases that need it.

---

## TL;DR (90-second upgrade)

- **Node ≥ 22** is required (Node 20 is EOL 2026-04-30). [Details](#1-install-and-engines-node--22).
- Your account registry (`GOOGLE_ACCOUNTS` / `GOOGLE_OPTIONAL_SCOPES` / `GOOGLE_ADMIN_ACCOUNTS`) moves into a mutable **`config.json`**. Run **`migrate-config`** and it writes the file for you. **Env still overrides**, so 12-factor deployments change nothing.
- Your `.env` **can** move to `~/.config/mcp-google-multi/.env`, but you don't have to: the working-directory and package-root `.env` still load (additive; nothing is taken away).
- Run **`migrate-config`**, then **`doctor`**, and fix anything red.
- **Re-auth only** the accounts `doctor` names (changing a scope profile re-runs Google consent).
- **Email format changed** (both directions): reads return **Markdown** for HTML-only mail; `body` on send is **Markdown**; `htmlBody` is **removed**. [Details](#3-email-format-breaking-both-directions).
- Optional: turn on the **HTTP transport** for the native Claude Code `/mcp` Authenticate button and the claude.ai connector.

Existing encrypted tokens keep decrypting: upgrading alone never forces a re-auth.

---

## Breaking changes at a glance

| # | Area | What changed | Your action | Slug if skipped |
|---|------|--------------|-------------|-----------------|
| 1 | Install | `engines.node` `>=20` → `>=22` | upgrade Node | `E_NODE_TOO_OLD` |
| 2 | Deps | `googleapis` monolith → `@googleapis/*` | none (automatic, `dist`-only) | n/a |
| 3 | Env loader | `dotenv` dropped for native `process.loadEnvFile` | none if env is set; else place a `.env` | `E_ENV_NOT_FOUND` |
| 4 | Config | account registry env → `config.json` | run `migrate-config` | `E_NO_ACCOUNTS_CONFIGURED` |
| 5 | Env | `GOOGLE_OPTIONAL_SCOPES` → per-account scope profiles | run `migrate-config` | `E_LEGACY_GLOBAL_SCOPES` (warn) |
| 6 | Env | `GOOGLE_ADMIN_ACCOUNTS` → per-account `admin` flag | run `migrate-config` | `E_LEGACY_ENV` (warn) |
| 7 | Behavior | tool-visibility modes added | none: default `lazy` = v5 | n/a |
| 8 | Behavior | default account (optional `account` param) | none, or set `GOOGLE_DEFAULT_ACCOUNT` | n/a |
| 9 | Email read | HTML-only body now Markdown | branch on `bodyFormat`; pass `rawHtml:true` for source | n/a |
| 10 | Email send | `body` is Markdown; `htmlBody` removed | rewrite callers ([§3](#3-email-format-breaking-both-directions)) | `E_HTMLBODY_REMOVED` |
| 11 | Removed | `alertcenter` bundle removed | drop it from any scope config | `E_UNKNOWN_BUNDLE` |
| 12 | Auth (opt-in) | HTTP `/mcp` + OAuth authorization server | opt-in only | n/a |
| 13 | Auth | OAuth redirect URI now configurable | none (default preserved) | n/a |
| 14 | Security | CRLF header-injection closed in email compose | none (input hardening) | n/a |
| 15 | Behavior | an undeclared tool argument is now refused, not dropped | none for a correct caller; see [§4.3](#43-undeclared-arguments-are-refused-not-dropped) | `unknown_argument` |
| 16 | Errors | caller-side 4xx split out of `upstream_error` | rebranch if you keyed on the slug; see [§4.4](#44-error-slugs-are-narrower) | `bad_request`, `internal` |
| 17 | Read tools | five list tools return an object, not a bare array | index `.files` / `.events` / `.instances` / `.contacts`; see [§4.5](#45-list-results-say-whether-they-are-complete) | n/a |
| 18 | Errors | wizard failures return a JSON envelope, not a prose line | parse `error` instead of reading the text; see [§4.6](#46-every-failure-is-an-envelope) | `E_ENV_ACCOUNTS_MODE`, `elicitation_unsupported` |
| 19 | Write-control | `safe-writes` also refuses privileged writes and push registration | on `safe-writes`, allow-list what you need or move to `full-writes`; see [§4.7](#47-safe-writes-is-no-longer-just-not-a-delete) | `write_disabled` |
| 20 | Read tools | `drive_read` flags an unreadable file with `isError` | treat `binary` and `too_large` as failures, which they already were | `binary`, `too_large` |

Rows 1, 3-6, 10-11, 17, 19 need action; rows 7-9, 12-16 and 18 are safe defaults, opt-in, or transparent fixes.

---

## 1. Install and engines (Node ≥ 22)

Node 20 reaches end-of-life on 2026-04-30; Node 22 is Active LTS and makes `process.loadEnvFile` stable. On Node < 22, v6 refuses to start with a clear `E_NODE_TOO_OLD` line (not a `TypeError` stack).

```sh
node -v            # must be >= 22
nvm install 22 && nvm use 22
```

`doctor` adds a line: `Node version: OK 22.x (>=22 required)`.

**Free win (already yours on current v5.x):** the switch from the `googleapis` monolith to right-sized `@googleapis/*` packages shrank install/download ~85% (≈218 MB → ≈32 MB; npx ≈18.6 MB → ≈4.2 MB) with byte-identical types. This shipped as a v5 minor *ahead* of v6, so a current v5 user already has it.

---

## 2. Config migration (`config.json` + `.env`)

This is one coupled move: **where your config and env live.** v5 read the registry from `GOOGLE_ACCOUNTS` at import, so a running server couldn't edit its own accounts. v6 moves the registry into a mutable `config.json` the setup wizard can write. **Secrets never move**: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MASTER_KEY` stay env-only, so `config.json` is safe to commit.

### 2.1 Run `migrate-config`

It reads your current env, synthesizes `config.json`, prints a before/after diff, and **never deletes env**. It is idempotent: safe to re-run.

```sh
mcp-google-multi migrate-config
```

The non-obvious mappings it handles for you:

- `GOOGLE_ACCOUNTS` `alias:email` pairs → the `accounts` map.
- `GOOGLE_OPTIONAL_SCOPES` (one global scope set) → a shared `legacy-global` scope profile.
- `GOOGLE_ADMIN_ACCOUNTS` → per-account `admin: true`.

### 2.2 What `config.json` looks like

Path: `${XDG_CONFIG_HOME:-~/.config}/mcp-google-multi/config.json`, beside `tokens/` and `discovery/`. It is plaintext by design (no secrets ever) and validated on load. You normally never hand-edit it: this is just so you recognize `migrate-config`'s output:

```jsonc
{
  "version": 1,
  "accounts": {
    "work":     { "email": "you@your-workspace.example", "scopeProfile": "workspace-admin", "admin": true },
    "personal": { "email": "you@example.com",            "scopeProfile": "base" }
  },
  "scopeProfiles": {
    "base":            { "bundles": [] },
    "workspace-admin": { "bundles": ["gmail_settings", "chat"], "admin": true }
  },
  "defaultAccount": "work",
  "discovery": "lazy"
}
```

Use whatever alias names you already had in `GOOGLE_ACCOUNTS`. Full field reference: [docs/configuration.md](./docs/configuration.md).

**Env still wins.** While `GOOGLE_ACCOUNTS` is set and non-empty, the whole registry comes from env and the file is ignored: 12-factor deployers keep working unchanged.

### 2.3 `.env` location (nothing is forced to move)

v5 loaded `.env` from the working directory then the package root. Because `npx` launches from an arbitrary directory, that working-directory `.env` was often silently missed: the classic first-run failure.

v6 **adds** `~/.config/mcp-google-multi/.env` as a new lowest-priority tier, plus an `MCP_GOOGLE_MULTI_ENV=/abs/path/.env` override. It does **not** remove the existing tiers. Precedence (highest first):

```
real environment  >  ./.env  >  <package-root>/.env  >  ~/.config/mcp-google-multi/.env
```

No move is forced: existing setups keep working. `doctor` detects a legacy-location `.env` and prints the exact `mv` if you want the stable path. A missing default `.env` is a valid state; only a missing **explicitly-requested** `MCP_GOOGLE_MULTI_ENV` path errors, with `E_ENV_NOT_FOUND` naming the path it looked for. The native loader also writes 0 bytes to stdio, structurally killing the old dotenv startup banner that corrupted the JSON-RPC channel.

### 2.4 Per-account scope profiles (replaces `GOOGLE_OPTIONAL_SCOPES`)

v5 applied one global `GOOGLE_OPTIONAL_SCOPES` to every account. v6 gives each account a named **scope profile** drawn from a curated bundle catalog (each bundle documents its scopes and a risk note). A still-set `GOOGLE_OPTIONAL_SCOPES` maps to an implicit `legacy-global` profile applied to all accounts, and `doctor` prints `E_LEGACY_GLOBAL_SCOPES` (a warning, not a failure). `GOOGLE_ADMIN_ACCOUNTS` maps to per-account `admin: true`, warned via `E_LEGACY_ENV`.

**Re-auth boundary:** changing a profile changes the consent set, so that account must re-auth. `doctor` names exactly which ones. Bundle names are frozen public API (renames go through an alias map), so a future rename is a soft alias, not a break. Bundle reference: [docs/configuration.md](./docs/configuration.md#optional-scope-bundles).

---

## 3. Email format (breaking, both directions)

This is the one behavior change likely to touch your callers.

| Direction | v5 | v6 | Your action |
|---|---|---|---|
| **Read** | HTML-only body flattened to text | HTML-only body → **Markdown** (via turndown); `text/plain` mail is unchanged; a new `bodyFormat` field is `markdown` or `text/plain` | branch on `bodyFormat`; pass `rawHtml:true` when you need the raw HTML source |
| **Send** | `body` = plain text; `htmlBody` = optional HTML | `body` = **Markdown** (rendered to a `multipart/alternative` with an auto-generated HTML part); **`htmlBody` is removed** | author `body` as Markdown; drop `htmlBody`; use `allowRawHtml:true` for the rare raw-HTML case |

**Silent trap: read this even if you never used `htmlBody`.** A v5 caller that passed only `body` with *plain prose containing Markdown metacharacters* now has it rendered as Markdown. Text like `# 1 priority`, `Cost: $5 * 3`, `> quoted`, or `[x] done` will render as a heading, emphasis, a blockquote, or a task item. If your prose isn't meant to be Markdown, escape the metacharacters or send it with `allowRawHtml:true` wrapping pre-escaped HTML.

Passing `htmlBody` now returns `E_HTMLBODY_REMOVED` with the exact rewrite. Color and other HTML-only styling are intentionally not expressible in Markdown; `allowRawHtml:true` is the documented escape hatch.

### 3.1 `htmlBody` → Markdown: before / after

```diff
- gmail_send({ to, subject,
-   body: "See the report.",
-   htmlBody: "<p>See the <a href='...'>report</a>.</p>" })

+ gmail_send({ to, subject,
+   body: "See the [report](...)." })          // Markdown IS the text/plain part; HTML auto-rendered

  // raw-HTML exception, color being the documented escape hatch:
+ gmail_send({ to, subject,
+   body: 'Status: <span style="color:#c00">overdue</span>',
+   allowRawHtml: true })
```

Additive email conveniences you now also get (nothing to migrate): attachments on both `gmail_send` and `gmail_create_draft`, reply auto-fill of to/cc/subject from `replyToMessageId`, `gmail_read_batch`, and an agent-callable contact/alias resolver. The old hand-rolled header encoders (a CRLF-injection surface) are gone: MailComposer validates and encodes headers and rejects embedded newlines.

---

## 4. Other behavior changes (safe defaults)

### 4.1 Tool visibility: default `lazy` (exactly v5)

The default is `lazy`: meta tools plus `{service}_discover` reveal, which is precisely v5's surface. Nothing to do on upgrade.

| Mode | Surface | Set via |
|---|---|---|
| `lazy` (default) | meta tools + revealed services; call `{service}_discover` first | `GOOGLE_DISCOVERY=lazy` or unset |
| `curated` | curated tools advertised eagerly; generated long-tail behind discover | `GOOGLE_DISCOVERY=curated` |
| `eager` | everything advertised | `GOOGLE_DISCOVERY=eager` |

New over stdio: agent-callable **expand** (reveal all curated at once) and **collapse** (return to lean) meta-tools. **HTTP forces `curated`** (a stateless transport has no cross-request reveal session); setting `lazy` with HTTP warns and is overridden.

### 4.2 Default account

`account` used to be required on every call. It becomes **optional** when `GOOGLE_DEFAULT_ACCOUNT` (or `config.defaultAccount`) is set: the default is injected at the single dispatch point when you omit it. `*`, CSV, and explicit aliases behave exactly as before, and a bare default is never treated as `*`. This is a relaxation, so nothing breaks; set it to drop the parameter from most calls.

### 4.3 Undeclared arguments are refused, not dropped

`GOOGLE_ARG_UNKNOWN` now defaults to **`reject`** (it was `warn`).

zod strips a key the tool does not declare before the handler runs, so in 5.x a misremembered parameter name produced a **successful** call that did something else. `drive_list` accepts eight plausible spellings of the folder argument and ignored every one of them, returning the My Drive root, byte-identical to calling it with no folder argument at all. The caller could not tell the difference.

An undeclared argument now fails the call with a typed envelope that names the likely parameter:

```json
{"error":"unknown_argument",
 "message":"drive_create_folder does not accept \"parentId\". Nothing was sent to Google.",
 "hint":"Did you mean \"parentFolderId\"? This tool accepts: account, name, parentFolderId.",
 "retriable":false}
```

**Who this breaks:** a client that appends the same non-namespaced key to every tool call. That is the one realistic break class, and it is a client or proxy behavior, not a model one.

Nothing else changes. These are never screened, in any mode:

- keys starting with `_`, and keys containing `/` (MCP and vendor metadata; the spec's own home for client metadata is `params._meta`, which sits outside `arguments` and is untouched)
- the client artifacts `random_string`, `toolCallId`, `tool_call_id`, `tool_call_description`
- tools that declare no arguments at all
- a key whose declared twin the same call also sent, since that call already behaves correctly
- a snake_case twin of a declared key, which is renamed before screening rather than refused

**To keep the old behavior:** `GOOGLE_ARG_UNKNOWN=warn` logs the drop to stderr and dispatches as 5.x did. `GOOGLE_ARG_UNKNOWN=off` restores the silent drop with no log. A misspelled value falls back to `warn`, not to the default.


### 4.4 Error slugs are narrower

`upstream_error` used to mean three different things. It now means one.

| Condition | Was | Now |
|---|---|---|
| Google returned 5xx | `upstream_error`, `retriable: true` | unchanged |
| Google returned a caller-side 4xx (400, 409, 412, 413, 415, 422) | `upstream_error`, `retriable: false` | **`bad_request`**, `retriable: false` |
| The server threw before sending anything (a bug, a missing key, an unknown alias) | `upstream_error`, hint "Unclassified error" | **`internal`**, or a precise slug: `auth_required`, `validation_error`, `invalid_client` |

A consumer branching on `error === 'upstream_error'` to decide whether to retry was previously getting both "Google is having a bad minute, retry" and "your request is wrong, never retry" under one name. If you branch on the slug, add the new cases; `retriable` already distinguished them and is unchanged.

Two related narrowings, same release:

- A 403 that is really a quota (`rateLimitExceeded`, `userRateLimitExceeded`, `dailyLimitExceeded`) is now `rate_limited` with `retriable: true`, instead of `forbidden` with a sharing hint.
- A 403 that is really the wrong tool for the file type (`fileNotDownloadable` on `drive_download`, `fileNotExportable` on `drive_export`) is now `binary_unsupported` and names the sibling tool, instead of `forbidden` with a permissions hint.

**Error messages are now capped** at 1000 characters, and the serialized envelope at 4000. A non-JSON response body (Google serves an HTML page whenever a request fails to route, most often because a path parameter was empty) is replaced by a one-line summary saying what was suppressed, rather than being embedded whole. Up to 8.5 KB of markup used to travel inside the `message` field.

### 4.5 List results say whether they are complete

Six read tools capped their output and returned the survivors as a bare JSON array. Nothing in the response said a cap had been applied, so 25 events and "all your events" were the same value. Callers reported the truncated list as the complete answer, which is the failure mode an agent cannot detect and cannot recover from.

These five now return an object:

| Tool | Array was | Key is now |
|---|---|---|
| `drive_search` | `[ {file}, ... ]` | `files` |
| `drive_list` | `[ {file}, ... ]` | `files` |
| `calendar_list_events` | `[ {event}, ... ]` | `events` |
| `calendar_list_instances` | `[ {event}, ... ]` | `instances` |
| `contacts_search` | `[ {contact}, ... ]` | `contacts` |

```jsonc
// before
[ { "id": "1", "name": "Q3 plan" }, { "id": "2", "name": "Q4 plan" } ]

// after
{
  "files": [ { "id": "1", "name": "Q3 plan" }, { "id": "2", "name": "Q4 plan" } ],
  "returned": 2,
  "truncated": true,
  "nextPageToken": "CAIQAA",
  "hint": "More files exist. Pass pageToken to continue from the end of this page."
}
```

`returned` and `truncated` are always present. `totalItems`, `nextPageToken` and `hint` appear only when the API supplies them: `hint` is present exactly when `truncated` is true.

`contacts_group_members` already returned an object and keeps its `group` and `members` keys; it gains `returned`, `truncated`, `totalItems` (the group's real `memberCount`) and, when some member records could not be fetched, `fetchFailures`.

**`pageToken` is new on** `drive_search`, `drive_list`, `calendar_list_events` and `calendar_list_instances`: pass back the `nextPageToken` you were given to fetch the next page. `contacts_search` and `contacts_group_members` do **not** get one: the underlying Google endpoints offer no continuation token, so those two report truncation and tell you to raise the page size instead.

Two related fixes ship with this:

- `drive_search` now reports Drive's `incompleteSearch` flag, which is set when Drive could not search every corpus. It was being discarded, so a partial search read as a complete one.
- `contacts_group_members` now fetches member records in batches of 200. `maxMembers` accepts up to 1000 but the underlying `people.getBatchGet` rejects more than 200 names, so a group larger than that used to fail outright.

### 4.6 Every failure is an envelope

A failure used to be reported in whichever shape its handler happened to use. Three were in circulation:

- the documented envelope, `{ error, message, hint?, retriable, account }`;
- an object whose `error` field held a whole English sentence, for example `{"error": "No fields to update"}`;
- a bare line of prose from the account wizard, for example `E_VALIDATION: Invalid alias "has space". Use letters, digits, "_" or "-".`

Only the first can be branched on. The second gives a different `error` value for every wording, so a client matching on it matches nothing and usage metrics count each phrasing separately. The third is not JSON at all.

All three are now the first shape. Concretely:

- **16 argument guards** across `admin`, `chat`, `contacts`, `docs`, `sheets` and `tasks` (the "no fields to update" and "supply one of X" checks) now return `invalid_params` with the fault in `message` and the list of accepted fields in `hint`.
- **The account wizard** (`account_add`, `account_reauth`, `account_write_config`) returns envelopes. The slugs are `E_ENV_ACCOUNTS_MODE`, `E_VALIDATION`, `E_ALIAS_EXISTS`, `E_UNKNOWN_BUNDLE`, `elicitation_unsupported`, `confirmation_declined`, `invalid_client`, `auth_required` and `internal`. Wizard **success** output stays prose: it is an onboarding report meant to be read, not parsed.
- **`account` is now carried** by `write_disabled`, by the `drive_transfer` and `drive_read` outcomes, and by the `docs_read` tab and heading errors, so a fan-out result can be attributed to the account that produced it. It is formally optional, because a few failures genuinely happen before any account is resolved.
- **`ambiguous_heading` is gone**; `docs_read` reports an ambiguous heading as `ambiguous`, the slug already used elsewhere for the same condition.
- Wizard and `diagnose` catch-alls no longer interpolate a raw thrown message. They go through the same capping and body-suppression path as every other error, which is what keeps a token or an HTML error page out of the response.

If you branch on `error`, the values are now drawn from one closed vocabulary; a test asserts that the set emitted anywhere in the source equals the set the metrics collector knows, so an unregistered slug cannot reach you as an unclassified `other`.

### 4.7 `safe-writes` is no longer just "not a delete"

**Only affects you if you run `GOOGLE_PROFILE=safe-writes`.** `read-only` and `full-writes` are unchanged.

`safe-writes` was implemented as `cud === 'create' || cud === 'update'`. That measures the shape of an operation, not what happens if it is wrong, and the two diverge badly:

- It permitted `admin_users_make_admin`, which grants super-admin, because promoting a user is an `update`.
- It permitted `admin_two_step_verification_turn_off`, `reseller_subscriptions_suspend` and `vault_matters_close` for the same reason.
- It permitted `script_scripts_run`, whose blast radius is whatever the script does, because running a script `create`s an execution.
- It permitted all ten `*_watch` methods, which register a webhook delivering your activity to an external URL.
- Meanwhile it refused `gmail_trash`, whose own description says "(recoverable)".

`safe-writes` now also refuses a write when either holds:

| Class | Test | Examples |
|---|---|---|
| Privileged scope | the method can be authorized by a scope acting on the whole org, legal holds, billing, or deployed code | `admin.directory.*`, `cloud-identity*`, `ediscovery*`, `apps.licensing`, `apps.order`, `apps.groups.settings`, `script.projects` |
| Push registration | the method registers a push channel | every `*_watch`, `workspaceevents` subscription create and reactivate |

Both are derived from the method's declared scopes and name rather than a hand-kept list of tool names, because the generated surface is regenerated from Discovery and a name list would drift silently. A method whose scopes are unknown is treated as **not** privileged: absent information is not evidence of privilege, and failing the other way would break ordinary writes.

`safe-writes` now permits 271 of 545 write tools instead of 385. Everything newly refused is Workspace administration, Vault, reseller billing, script deployment, or push registration. **No `gmail`, `drive`, `calendar`, `docs`, `sheets`, `tasks` or `contacts` write changed**, with the single exception of the seven `*_watch` registrations in those services.

**If something you rely on is now refused**, the refusal names the tool and suggests a pattern that works:

```
GOOGLE_WRITE_ALLOW="admin:users_make_admin"
```

An explicit allow still wins over the profile, because naming a tool is a deliberate opt-in; `GOOGLE_WRITE_DENY` still wins over that. Or move to `GOOGLE_PROFILE=full-writes`, which is unchanged.

This does not close the remaining gap: irreversibility is still not part of the verdict, and `IRREVERSIBLE_TOOLS` continues to drive only the client-side confirmation prompt.

### 4.8 `drive_read` marks an unreadable file as an error

Asking `drive_read` for a PNG, or for a non-Google file over the 2 MB inline cap, returned a result carrying `"error": "binary"` or `"error": "too_large"` but **without** `isError`. So the call was a success that contained an error field: metrics counted it in the success bucket, and a client checking `isError` saw nothing wrong while getting no content back.

Both slugs were already in the server's error vocabulary, which is what gives the game away: they were meant to be errors and never arrived as any.

They now set `isError: true`. The payload is otherwise unchanged and still carries `id`, `name`, `mimeType` and `webViewLink` alongside the hint pointing at `drive_download` or `drive_export`.

---

### 4.x Package deep imports are now declared (`exports` map)

v6 adds a package `exports` map. The supported programmatic entry points are
declared explicitly (`mcp-google-multi/identity`, `/compose`, `/registry`,
`/oauth-as`, `/accounts`, `/token-store`, `/http-transport`, `/http-config`,
`/client`, `/config-file`, `/fs-atomic`, `/master-key`, `/mcp-token`,
`/boot-gates`, `/tenant-purge`, `/doctor`, `/write-control`,
`/scope-catalog`, `/auth`). Any OTHER deep import into `dist/` (previously unrestricted, e.g.
`mcp-google-multi/dist/trim.js`) now fails with
`ERR_PACKAGE_PATH_NOT_EXPORTED`. The CLI (`npx mcp-google-multi ...`) and the
MCP server entry are unaffected. If you relied on an undeclared deep import,
open an issue naming the module so it can be promoted to a declared entry.

`buildRegistry(server, ctx)` resolves every registered tool through `ctx`:
the client, token reads, account emails (the From header, `drive_transfer`'s
share target), scope hints, `account_list` and `diagnose`. Only the owner
context from `buildIdentityContext()` (see `isOwnerContext`) gets the account
wizard and the tools that read or write the server's own disk
(`drive_upload`, `drive_download`, `drive_export`, `gmail_download_attachment`,
`drive_update`'s `localPath`, `gmail_send`/`gmail_create_draft` attachments);
a context built any other way is served without them. `registerDiagnoseTool`
now takes `{ subject, accounts, getClient, tokenStore }` (an `IdentityContext`
satisfies it), and `ToolRegistry#accountSet()` is new. `/write-control`
exports `resolvePolicy`, `isAllowed` and the `Policy` type for callers that
build their own context. `owner` is now a reserved tenant id: the tenant
path helpers in `/config-file` (`tenantTokenDir`, `tenantConfigFilePath`,
`ensureTenantDirs`) reject it with `E_TENANT_ID_INVALID`. The free core's
single-owner behavior is unchanged.

`HttpHostOptions.resolveServer` now returns a `ServerTarget`: the server plus
the per-request hooks bound to that server's registry (`argShapeFor`,
`strictArgs`, `validationEnvelope`). With a resolver, only the target's hooks
apply; the host-level ones describe the boot server alone. `requestHooksFor(registry, ctx)`
in `/compose` builds those hooks for one registry, exactly as both built-in
transports do; the metrics observers (`metricsTap`, `onArgRename`) stay
host-wide. Dispatch is serialized per resolved server, so a resolver may map
several subjects to one server safely.

`/oauth-as`: `/callback` now awaits `bindTenantAlias`. A binder that returns
`{ refused: { slug, message } }` gets a 403 with that slug (a slug that is not
a bare identifier renders as `access_denied`); a throw or a rejection is still
a 500 `E_ALIAS_ADD_FAILED`. Its argument type is exported as `TenantAliasBind`
and the refusal as `AliasBindRefusal`. `mintFlowState`, `StatePayload` and
`TenantAliasBind` gain an optional signed `nonce`, and `buildGoogleAuthUrl`
now receives the signed `bundles`. `verifiedEmailFromIdToken` is exported.
`/scope-catalog` (`BUNDLE_CATALOG`, `isKnownBundle`, `resolveBundleAliases`, `closestBundle`)
and `/auth` (`BASE_SCOPES`, `resolveScopesForAccount`) are new declared
entries.

## 5. Auth changes

### 5.1 New: HTTP transport + `/mcp` OAuth (opt-in, additive)

stdio stays the default. HTTP exists mainly so Claude Code's native `/mcp` Authenticate button (`claude mcp login`), keychain, and auto-refresh work, and so the claude.ai connector can reach the server.

| Item | Behavior |
|---|---|
| Model | **Federate-and-hold.** The server is its own OAuth 2.1 authorization server to the client (audience-bound token) and separately runs the Google flow, holding Google tokens server-side. It never passes the client token to Google, and never accepts a Google token from the client. |
| Owner gate | `MCP_OWNER_EMAILS` allowlists the Google account(s) allowed to authenticate. It is **required** whenever `MCP_TRANSPORT` includes `http`; empty ⇒ startup fails with `E_OWNER_EMAILS_REQUIRED`. |
| Client registration | CIMD **plus** a minimal DCR `/register` endpoint, on by default. |
| Redirect URI | Now configurable (was hardcoded `http://localhost:4242/oauth2callback`); the default is preserved for local use. Remote HTTP uses `${MCP_PUBLIC_URL}/callback`. |
| Turn it on | `MCP_TRANSPORT=http` + the connector URL in your client. Full walkthrough in **[docs/http-setup.md](./docs/http-setup.md)**, including the Cloudflare **named** tunnel path (quick tunnels are demo-only) and one-click Render/Railway deploys. |
| Trust caveat | Behind a tunnel, **Cloudflare terminates TLS and can see the bearer token and all Gmail/Drive bytes in transit.** This is a trust boundary you accept, not a bug. |

### 5.2 Existing tokens keep working

The encrypted-store crypto is unchanged (AES-256-GCM). Existing `<alias>.enc` files decrypt as-is: no re-encryption and no re-auth just because you upgraded.

### 5.3 Re-auth: when it's required

| Trigger | Re-auth? |
|---|---|
| Plain version bump, scopes unchanged | No |
| You change a scope profile | Yes: that account only |
| You move an account to `admin` | Yes: that account |

v6 names the exact accounts that need re-auth instead of letting calls 403 later. Where your client supports it, an expired Google refresh token (the 7-day "Testing" mode trap) is surfaced as an MCP auth challenge so the client re-runs the flow and resumes the original call: self-healing that depends on the client honoring the challenge. The durable fix is still setting your Google app's Publishing status to **In production**.

Re-auth a named account with:

```sh
mcp-google-multi auth --account <alias>
```

---

## 6. `MASTER_KEY`: now auto-provisioned (mostly invisible)

| Item | Behavior |
|---|---|
| v5 | `MASTER_KEY` was hard-required in env; the server exited if it was missing. |
| v6 | Resolves in order: **env → OS keychain → generate-on-setup.** Generated keys are stored in the OS keychain with a `0600`-file fallback. `doctor` shows provenance (`MASTER_KEY: env | keychain | file`). |
| Hard safety guard | If encrypted tokens already exist and **no** key is recoverable, v6 **refuses** to generate a new one and errors (`E_MASTER_KEY_MISSING_TOKENS_EXIST`), routing you to the reset path rather than silently bricking your tokens. |
| Server deploys | Keep providing `MASTER_KEY` via env / your secret manager. |

This protects tokens **at rest**, not against same-user malware: exactly like a plaintext `.env` did. See [docs/secrets.md](./docs/secrets.md) for keeping it out of a plaintext file entirely.

---

## 7. Removed features

- **Alert Center bundle**: removed. It was declared but never functional (service-account only; never a real tool or grantable scope). Referencing an `alertcenter` bundle in a profile now yields `E_UNKNOWN_BUNDLE`.
- **Service accounts / Domain-Wide Delegation**: declined on principle. This is a consent-first product; SA + DWD is blanket domain impersonation. Not a supported feature (documentation, not code).

---

## 8. Step-by-step upgrade runbook

0. Read [Breaking changes at a glance](#breaking-changes-at-a-glance). Back up `~/.config/mcp-google-multi/` (copy the whole directory).
1. Upgrade Node to ≥ 22 (`nvm install 22 && nvm use 22`).
2. Keep or place your `.env`. It can stay in the working directory / package root (still loaded), or move to `~/.config/mcp-google-multi/.env`, or point `MCP_GOOGLE_MULTI_ENV` at it. Keep `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and (if set) `MASTER_KEY` there.
3. Install v6: `npx -y mcp-google-multi@6` (or bump the `claude mcp` entry / your MCPB bundle).
4. Run `mcp-google-multi migrate-config`: writes `config.json` from the old env vars and prints a diff. Nothing is deleted; env still overrides.
5. Run `mcp-google-multi doctor`. Fix anything red. It exits non-zero on failure; `--json` for scripts; `--report` emits a redacted, paste-ready bug report.
6. Re-auth only the accounts `doctor` names: `mcp-google-multi auth --account <alias>`.
7. *(Optional)* Turn on HTTP: set `MCP_TRANSPORT=http` and follow [docs/http-setup.md](./docs/http-setup.md).
8. *(Optional)* Once `doctor` is green, delete the leftover `GOOGLE_OPTIONAL_SCOPES` / `GOOGLE_ADMIN_ACCOUNTS` env vars.
9. Update any `gmail_send` / `gmail_create_draft` callers: drop `htmlBody`, author `body` as Markdown ([§3.1](#31-htmlbody--markdown-before--after)); branch email readers on `bodyFormat`.

---

## 9. Rollback and downgrade traps

v6 does not touch v5 tokens and does not overwrite v5 env, so rollback is clean: reinstall `mcp-google-multi@5`, keep `.env` where v5 expects it (working directory / package root), ignore `config.json`. No data is lost. Two traps to know before you downgrade:

- **`MASTER_KEY` keychain-only.** If v6 auto-provisioned `MASTER_KEY` into the OS keychain with **no** env copy, an env-only v5 cannot find it and token decryption breaks. Before downgrading, export the key from the keychain into `.env` (or, during any period you might roll back, keep `MASTER_KEY` in env rather than keychain-only). v6 also mirrors an env key into the keychain on first successful decrypt to reduce this risk.
- **`config.json` version.** A future `config.json` written by a newer v6 (`version: 2`) is rejected by an older reader with `E_CONFIG_VERSION_UNSUPPORTED` rather than crashing: but that also means a newer file won't load on an older binary. If you downgrade across a config-version bump, restore the older `config.json` from your backup (step 0).

Email and tool-visibility changes are code-level only: downgrading the package restores v5 behavior with no data implication.

---

## 10. Getting help

Every error prints a stable `E_*` slug plus an inline fix hint: search the slug (in these docs or the issue tracker) to find the fix. For a bug report, `mcp-google-multi doctor --report` emits a **redacted, paste-ready** diagnostic so report quality doesn't depend on remembering what to include. Configuration reference: [docs/configuration.md](./docs/configuration.md). Feature rationale: [docs/features.md](./docs/features.md).
