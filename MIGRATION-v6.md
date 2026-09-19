# Migrating to v6 (`6.0.0`)

v6 is one big-bang major that batches every foreseeable breaking change so you migrate **once**. Most installs need **three edits and one re-auth**. The trust model is unchanged: you bring your own Google OAuth client, tokens stay encrypted on your disk, and writes are deny-by-default.

If you keep secrets and accounts in env vars for a server deployment, the short version is: **upgrade Node to 22, run `migrate-config`, run `doctor`, re-auth what it names.** Everything below is detail for the cases that need it.

---

## TL;DR (90-second upgrade)

- **Node ≥ 22** is required (Node 20 is EOL 2026-04-30). [Details](#1-install-and-engines-node--22).
- Your account registry (`GOOGLE_ACCOUNTS` / `GOOGLE_OPTIONAL_SCOPES` / `GOOGLE_ADMIN_ACCOUNTS`) moves into a mutable **`config.json`**. Run **`migrate-config`** and it writes the file for you. **Env still overrides**, so 12-factor deployments change nothing.
- Your `.env` **can** move to `~/.config/mcp-google-multi/.env`, but you don't have to — the working-directory and package-root `.env` still load (additive; nothing is taken away).
- Run **`migrate-config`**, then **`doctor`**, and fix anything red.
- **Re-auth only** the accounts `doctor` names (changing a scope profile re-runs Google consent).
- **Email format changed** (both directions): reads return **Markdown** for HTML-only mail; `body` on send is **Markdown**; `htmlBody` is **removed**. [Details](#3-email-format-breaking-both-directions).
- Optional: turn on the **HTTP transport** for the native Claude Code `/mcp` Authenticate button and the claude.ai connector.

Existing encrypted tokens keep decrypting — upgrading alone never forces a re-auth.

---

## Breaking changes at a glance

| # | Area | What changed | Your action | Slug if skipped |
|---|------|--------------|-------------|-----------------|
| 1 | Install | `engines.node` `>=20` → `>=22` | upgrade Node | `E_NODE_TOO_OLD` |
| 2 | Deps | `googleapis` monolith → `@googleapis/*` | none (automatic, `dist`-only) | — |
| 3 | Env loader | `dotenv` dropped for native `process.loadEnvFile` | none if env is set; else place a `.env` | `E_ENV_NOT_FOUND` |
| 4 | Config | account registry env → `config.json` | run `migrate-config` | `E_NO_ACCOUNTS_CONFIGURED` |
| 5 | Env | `GOOGLE_OPTIONAL_SCOPES` → per-account scope profiles | run `migrate-config` | `E_LEGACY_GLOBAL_SCOPES` (warn) |
| 6 | Env | `GOOGLE_ADMIN_ACCOUNTS` → per-account `admin` flag | run `migrate-config` | `E_LEGACY_ENV` (warn) |
| 7 | Behavior | tool-visibility modes added | none — default `lazy` = v5 | — |
| 8 | Behavior | default account (optional `account` param) | none, or set `GOOGLE_DEFAULT_ACCOUNT` | — |
| 9 | Email read | HTML-only body now Markdown | branch on `bodyFormat`; pass `rawHtml:true` for source | — |
| 10 | Email send | `body` is Markdown; `htmlBody` removed | rewrite callers ([§3](#3-email-format-breaking-both-directions)) | `E_HTMLBODY_REMOVED` |
| 11 | Removed | `alertcenter` bundle removed | drop it from any scope config | `E_UNKNOWN_BUNDLE` |
| 12 | Auth (opt-in) | HTTP `/mcp` + OAuth authorization server | opt-in only | — |
| 13 | Auth | OAuth redirect URI now configurable | none (default preserved) | — |
| 14 | Security | CRLF header-injection closed in email compose | none (input hardening) | — |

Rows 1, 3–6, 10–11 need action; rows 7–9, 12–14 are safe defaults, opt-in, or transparent fixes.

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

This is one coupled move: **where your config and env live.** v5 read the registry from `GOOGLE_ACCOUNTS` at import, so a running server couldn't edit its own accounts. v6 moves the registry into a mutable `config.json` the setup wizard can write. **Secrets never move** — `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MASTER_KEY` stay env-only, so `config.json` is safe to commit.

### 2.1 Run `migrate-config`

It reads your current env, synthesizes `config.json`, prints a before/after diff, and **never deletes env**. It is idempotent — safe to re-run.

```sh
mcp-google-multi migrate-config
```

The non-obvious mappings it handles for you:

- `GOOGLE_ACCOUNTS` `alias:email` pairs → the `accounts` map.
- `GOOGLE_OPTIONAL_SCOPES` (one global scope set) → a shared `legacy-global` scope profile.
- `GOOGLE_ADMIN_ACCOUNTS` → per-account `admin: true`.

### 2.2 What `config.json` looks like

Path: `${XDG_CONFIG_HOME:-~/.config}/mcp-google-multi/config.json`, beside `tokens/` and `discovery/`. It is plaintext by design (no secrets ever) and validated on load. You normally never hand-edit it — this is just so you recognize `migrate-config`'s output:

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

**Env still wins.** While `GOOGLE_ACCOUNTS` is set and non-empty, the whole registry comes from env and the file is ignored — 12-factor deployers keep working unchanged.

### 2.3 `.env` location (nothing is forced to move)

v5 loaded `.env` from the working directory then the package root. Because `npx` launches from an arbitrary directory, that working-directory `.env` was often silently missed — the classic first-run failure.

v6 **adds** `~/.config/mcp-google-multi/.env` as a new lowest-priority tier, plus an `MCP_GOOGLE_MULTI_ENV=/abs/path/.env` override. It does **not** remove the existing tiers. Precedence (highest first):

```
real environment  >  ./.env  >  <package-root>/.env  >  ~/.config/mcp-google-multi/.env
```

No move is forced — existing setups keep working. `doctor` detects a legacy-location `.env` and prints the exact `mv` if you want the stable path. A missing default `.env` is a valid state; only a missing **explicitly-requested** `MCP_GOOGLE_MULTI_ENV` path errors, with `E_ENV_NOT_FOUND` naming the path it looked for. The native loader also writes 0 bytes to stdio, structurally killing the old dotenv startup banner that corrupted the JSON-RPC channel.

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

**Silent trap — read this even if you never used `htmlBody`.** A v5 caller that passed only `body` with *plain prose containing Markdown metacharacters* now has it rendered as Markdown. Text like `# 1 priority`, `Cost: $5 * 3`, `> quoted`, or `[x] done` will render as a heading, emphasis, a blockquote, or a task item. If your prose isn't meant to be Markdown, escape the metacharacters or send it with `allowRawHtml:true` wrapping pre-escaped HTML.

Passing `htmlBody` now returns `E_HTMLBODY_REMOVED` with the exact rewrite. Color and other HTML-only styling are intentionally not expressible in Markdown; `allowRawHtml:true` is the documented escape hatch.

### 3.1 `htmlBody` → Markdown: before / after

```diff
- gmail_send({ to, subject,
-   body: "See the report.",
-   htmlBody: "<p>See the <a href='...'>report</a>.</p>" })

+ gmail_send({ to, subject,
+   body: "See the [report](...)." })          // Markdown IS the text/plain part; HTML auto-rendered

  // raw-HTML exception (color — the documented escape hatch):
+ gmail_send({ to, subject,
+   body: 'Status: <span style="color:#c00">overdue</span>',
+   allowRawHtml: true })
```

Additive email conveniences you now also get (nothing to migrate): attachments on both `gmail_send` and `gmail_create_draft`, reply auto-fill of to/cc/subject from `replyToMessageId`, `gmail_read_batch`, and an agent-callable contact/alias resolver. The old hand-rolled header encoders (a CRLF-injection surface) are gone — MailComposer validates and encodes headers and rejects embedded newlines.

---

## 4. Other behavior changes (safe defaults)

### 4.1 Tool visibility — default `lazy` (exactly v5)

The default is `lazy`: meta tools plus `{service}_discover` reveal, which is precisely v5's surface. Nothing to do on upgrade.

| Mode | Surface | Set via |
|---|---|---|
| `lazy` (default) | meta tools + revealed services; call `{service}_discover` first | `GOOGLE_DISCOVERY=lazy` or unset |
| `curated` | curated tools advertised eagerly; generated long-tail behind discover | `GOOGLE_DISCOVERY=curated` |
| `eager` | everything advertised | `GOOGLE_DISCOVERY=eager` |

New over stdio: agent-callable **expand** (reveal all curated at once) and **collapse** (return to lean) meta-tools. **HTTP forces `curated`** (a stateless transport has no cross-request reveal session); setting `lazy` with HTTP warns and is overridden.

### 4.2 Default account

`account` used to be required on every call. It becomes **optional** when `GOOGLE_DEFAULT_ACCOUNT` (or `config.defaultAccount`) is set — the default is injected at the single dispatch point when you omit it. `*`, CSV, and explicit aliases behave exactly as before, and a bare default is never treated as `*`. This is a relaxation, so nothing breaks; set it to drop the parameter from most calls.

---

## 5. Auth changes

### 5.1 New: HTTP transport + `/mcp` OAuth (opt-in, additive)

stdio stays the default. HTTP exists mainly so Claude Code's native `/mcp` Authenticate button (`claude mcp login`), keychain, and auto-refresh work, and so the claude.ai connector can reach the server.

| Item | Behavior |
|---|---|
| Model | **Federate-and-hold.** The server is its own OAuth 2.1 authorization server to the client (audience-bound token) and separately runs the Google flow, holding Google tokens server-side. It never passes the client token to Google, and never accepts a Google token from the client. |
| Owner gate | `MCP_OWNER_EMAILS` allowlists the Google account(s) allowed to authenticate. It is **required** whenever `MCP_TRANSPORT` includes `http`; empty ⇒ startup fails with `E_OWNER_EMAILS_REQUIRED`. |
| Client registration | CIMD **plus** a minimal DCR `/register` endpoint, on by default. |
| Redirect URI | Now configurable (was hardcoded `http://localhost:4242/oauth2callback`); the default is preserved for local use. Remote HTTP uses `${MCP_PUBLIC_URL}/callback`. |
| Turn it on | `MCP_TRANSPORT=http` + the connector URL in your client. Full walkthrough — including the Cloudflare **named** tunnel path (quick tunnels are demo-only) and one-click Render/Railway deploys — in **[docs/http-setup.md](./docs/http-setup.md)**. |
| Trust caveat | Behind a tunnel, **Cloudflare terminates TLS and can see the bearer token and all Gmail/Drive bytes in transit.** This is a trust boundary you accept, not a bug. |

### 5.2 Existing tokens keep working

The encrypted-store crypto is unchanged (AES-256-GCM). Existing `<alias>.enc` files decrypt as-is: no re-encryption and no re-auth just because you upgraded.

### 5.3 Re-auth: when it's required

| Trigger | Re-auth? |
|---|---|
| Plain version bump, scopes unchanged | No |
| You change a scope profile | Yes — that account only |
| You move an account to `admin` | Yes — that account |

v6 names the exact accounts that need re-auth instead of letting calls 403 later. Where your client supports it, an expired Google refresh token (the 7-day "Testing" mode trap) is surfaced as an MCP auth challenge so the client re-runs the flow and resumes the original call — self-healing that depends on the client honoring the challenge. The durable fix is still setting your Google app's Publishing status to **In production**.

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

This protects tokens **at rest**, not against same-user malware — exactly like a plaintext `.env` did. See [docs/secrets.md](./docs/secrets.md) for keeping it out of a plaintext file entirely.

---

## 7. Removed features

- **Alert Center bundle** — removed. It was declared but never functional (service-account only; never a real tool or grantable scope). Referencing an `alertcenter` bundle in a profile now yields `E_UNKNOWN_BUNDLE`.
- **Service accounts / Domain-Wide Delegation** — declined on principle. This is a consent-first product; SA + DWD is blanket domain impersonation. Not a supported feature (documentation, not code).

---

## 8. Step-by-step upgrade runbook

0. Read [Breaking changes at a glance](#breaking-changes-at-a-glance). Back up `~/.config/mcp-google-multi/` (copy the whole directory).
1. Upgrade Node to ≥ 22 (`nvm install 22 && nvm use 22`).
2. Keep or place your `.env`. It can stay in the working directory / package root (still loaded), or move to `~/.config/mcp-google-multi/.env`, or point `MCP_GOOGLE_MULTI_ENV` at it. Keep `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and (if set) `MASTER_KEY` there.
3. Install v6: `npx -y mcp-google-multi@6` (or bump the `claude mcp` entry / your MCPB bundle).
4. Run `mcp-google-multi migrate-config` — writes `config.json` from the old env vars and prints a diff. Nothing is deleted; env still overrides.
5. Run `mcp-google-multi doctor`. Fix anything red. It exits non-zero on failure; `--json` for scripts; `--report` emits a redacted, paste-ready bug report.
6. Re-auth only the accounts `doctor` names: `mcp-google-multi auth --account <alias>`.
7. *(Optional)* Turn on HTTP: set `MCP_TRANSPORT=http` and follow [docs/http-setup.md](./docs/http-setup.md).
8. *(Optional)* Once `doctor` is green, delete the leftover `GOOGLE_OPTIONAL_SCOPES` / `GOOGLE_ADMIN_ACCOUNTS` env vars.
9. Update any `gmail_send` / `gmail_create_draft` callers: drop `htmlBody`, author `body` as Markdown ([§3.1](#31-htmlbody--markdown-before--after)); branch email readers on `bodyFormat`.

---

## 9. Rollback and downgrade traps

v6 does not touch v5 tokens and does not overwrite v5 env, so rollback is clean: reinstall `mcp-google-multi@5`, keep `.env` where v5 expects it (working directory / package root), ignore `config.json`. No data is lost. Two traps to know before you downgrade:

- **`MASTER_KEY` keychain-only.** If v6 auto-provisioned `MASTER_KEY` into the OS keychain with **no** env copy, an env-only v5 cannot find it and token decryption breaks. Before downgrading, export the key from the keychain into `.env` (or, during any period you might roll back, keep `MASTER_KEY` in env rather than keychain-only). v6 also mirrors an env key into the keychain on first successful decrypt to reduce this risk.
- **`config.json` version.** A future `config.json` written by a newer v6 (`version: 2`) is rejected by an older reader with `E_CONFIG_VERSION_UNSUPPORTED` rather than crashing — but that also means a newer file won't load on an older binary. If you downgrade across a config-version bump, restore the older `config.json` from your backup (step 0).

Email and tool-visibility changes are code-level only: downgrading the package restores v5 behavior with no data implication.

---

## 10. Getting help

Every error prints a stable `E_*` slug plus an inline fix hint — search the slug (in these docs or the issue tracker) to find the fix. For a bug report, `mcp-google-multi doctor --report` emits a **redacted, paste-ready** diagnostic so report quality doesn't depend on remembering what to include. Configuration reference: [docs/configuration.md](./docs/configuration.md). Feature rationale: [docs/features.md](./docs/features.md).
