# Working on mcp-google-multi

Conventions for AI assistants modifying this codebase. v6 is **user-OAuth only**: stdio by default, optional Streamable HTTP (`MCP_TRANSPORT=http|both`) behind a built-in OAuth 2.1 authorization server; one owner identity context per transport, with seams (hint provider, boot gates, tenant purge) a multi-tenant host can fill. User-facing rationale for the big mechanisms (discover-first, fan-out, trimming, write-control, escape hatch) lives in `docs/features.md`; implementation rationale too long for a code comment (Windows rename retry, GET/HEAD body stripping, admin-scope gating) lives in `docs/internals.md`. Keep both in sync when behavior changes — comments stay one-line and point there.

## Project shape

- `src/index.ts` — entry. `main()` dispatches the CLI commands (`auth`, `migrate-tokens`, `migrate-config`, `doctor`, `reset`, `metrics`, `write-client-config`, `account export|import`, `config check`), else resolves the transport (`src/http-config.ts`), the master key and usage metrics, then builds one `McpServer` + identity context + registry per transport: stdio, and/or HTTP (forces `curated` mode, mounts the OAuth AS, refuses to boot without `MCP_OWNER_EMAILS` unless multi-tenant boot gates are installed). Each registry's `installListHandler()` runs before connect.
- `src/compose.ts` — `buildRegistry(server, ctx, mode?, metrics?)` registers every enabled service (the curated `SERVICES` table plus `GENERATED_SERVICES`, gates in `src/services.ts`, all filtered by `GOOGLE_TOOLSETS`), fails fast if `registry.services()` is empty (BEFORE meta tools register — escape tools would mask an empty service set), then `registerDiscoverTools()` + `registerEscapeTools()` + `registerAccountTools()` + `registerDiagnoseTool()`, plus `registerAccountWizardTools()` for the owner context only. `requestHooksFor()` builds the per-request arg-normalization / unknown-arg / validation-envelope hooks both transports share. No import-time side effects.
- `src/registry.ts` — `ToolRegistry` wraps the MCP server: records a `ToolEntry` per tool (`name, service, cud, description, inputShape, annotations, clientMeta?, meta, generated, irreversible, requiredScopes?`), derives `cud` (read/create/update/delete) from the tool name via `inferCud`, **enforces write-control** by wrapping every CUD handler, injects computed annotations (`readOnlyHint`/`destructiveHint`; `anthropic/requiresUserInteraction` on `IRREVERSIBLE_TOOLS`), and owns **discover-first visibility**: all tools register eagerly (always callable — graceful dispatch), but the custom `tools/list` handler advertises per `GOOGLE_DISCOVERY` mode (`lazy` default = meta + `reveal()`ed services; `curated` = + all curated; `eager` = everything; `generated` provenance on ToolEntry from the explicit-cud marker; tools no catalog bundle can authorize are never advertised). `discover_all`/`discover_reset` metas toggle a runtime lazy→curated overlay (`expand()`/`collapse()`, both fire `tools/list_changed`; collapse also clears reveals — a client mishandling a shrinking list degrades collapse to a session no-op, zero correctness impact). `hideServices(services)` keeps whole services out of `tools/list` whatever the mode or a later reveal (hidden, not unregistered: still callable by name and listed by `{service}_discover`; meta tools never hidden; each call replaces the earlier set) for a host that serves one registry per identity. The `httpConfirm` field (`HttpConfirm`, see `src/http-confirm.ts`) decides how an escape-hatch write is confirmed over HTTP. `installListHandler()` must run after registration, before connect. Service files call `server.registerTool(...)` — `server` is a `ToolRegistry`.
- `src/discover.ts` — `registerDiscoverTools()`: one eager `{service}_discover` meta-tool per service; returns the catalog (`registry.catalog`), reveals the service, triggers `tools/list_changed`. Never emit `tool_reference` content blocks or top-level `defer_loading` fields — strict SDK clients reject/strip them (a client-side constraint, independent of the server SDK version).
- `src/toolsets.ts` — `GOOGLE_TOOLSETS` parsing (`all` | CSV of service names).
- `src/discovery-client.ts` — runtime Google API Discovery: `loadMethodIndex(api)` fetches `https://www.googleapis.com/discovery/v1/apis/{id}/{version}/rest` on demand, disk-caches 7 days (`DISCOVERY_CACHE_PATH`), stale-if-offline; `cudFromMethod` (HTTP verb → cud, POST read-verbs like batchGet → read), `expandPath` ({param} + {+param} templates), `searchMethods`. Deps injectable for tests — never hit the network in unit tests.
- `src/tools/google-api.ts` — `registerEscapeTools()`: eager `google_api_search` + `google_api_call`. The call tool enforces write-control ITSELF (its registry cud is read, so the wrapper doesn't gate it) via `isAllowed` on the method's derived cud — keep that check when touching this file.
- `src/fanout.ts` — cross-account fan-out: `parseAccountSelector` (`"*"` | CSV | single), `runFanout` (bounded 5, per-account isolation, merged `{results, partial}` envelope with parsed payloads; never embed raw JSON strings), `fanoutAccountField` (union schema: a live `*`-or-alias check | CSV regex; the set is read at parse time). Wired in `registry.ts`: read tools only, never meta (`google_api_call` infers cud=read but executes writes), never `FANOUT_EXCLUDE` (read tools that write local files). Fan-out wraps the raw handler INNERMOST so compaction runs once on the merged envelope.
- `src/tools/accounts-tool.ts` — eager `account_list` meta tool + `deriveAccountHealth` (pure, deps-injectable). Reads the context's token store through `accountHealthDepsFor(ctx.tokenStore)` — NEVER `getClient` (would attach refresh listeners). `readToken` throws on decrypt failure (only returns null when missing) — keep the per-account try/catch. Never output token values.
- `src/trim.ts` — response trimming: `compactResult` (registry re-serializes every JSON text output compactly; `GOOGLE_TRIM=off` opts out — compaction only, never the caps), `capText` (paging caps with truncated/totalChars), `sliceClean` (permanent caps — drops a trailing lone surrogate). Fat readers own their caps: `drive_read` `maxChars`/`offset`, gmail reads 50k body cap + `full` param, `calendar_list_events` AND `calendar_list_instances` list-mode `formatEvent(e, {full:false})`. New fat-payload tools should reuse these helpers.
- `src/write-control.ts` — `resolvePolicy()` (env → policy) + `isAllowed()` (deny-by-default verdict) + `denyReason()`/`writeDisabledResult()` + `describePolicy()` (`config check` rendering) + `IRREVERSIBLE_TOOLS`. `src/outbound-allowlist.ts` — opt-in `GOOGLE_OUTBOUND_ALLOWLIST` recipient gate (Gmail recipients, Calendar attendees, Drive grantees, escape-hatch bodies); off when unset.
- `src/token-store.ts` — encrypted token store (AES-256-GCM, key from `resolveMasterKey()`); `readToken`/`writeToken`/`updateToken`/`hasToken` over the owner dir, `createTokenStore(dir, {tenantId?})` for any other. The `migrate-tokens` CLI lives in `src/migrate-tokens.ts`. `src/master-key.ts` — `MASTER_KEY` and `MCP_JWT_KEY` resolution (see Auth / tokens).
- `src/auth.ts` — OAuth flow + per-account scope resolution: each account's `scopeProfile` (from the AccountSet) selects bundles from the catalog; `getOptionalBundles()` returns the UNION across accounts (drives service registration), authz stays per-account; legacy `GOOGLE_OPTIONAL_SCOPES` acts as an implicit global profile (warns). `src/scope-catalog.ts` — the ONE bundle catalog (scopes + description + risk + workspaceOnly; keys are frozen public API, renames via BUNDLE_ALIASES only); unknown bundle names fail E_UNKNOWN_BUNDLE with a did-you-mean hint.
- `src/client.ts` — `makeGetClient(contextKey, deps)` builds a context's client factory; `getClient` is the owner's. Fresh OAuth2Client per call from the encrypted token (concurrent calls for one alias share the in-flight build); its `tokens` listener re-encrypts on refresh (`updateToken`). `CuratedToolDeps` (`getClientFn`, `localFiles`) is the injection surface for curated tool files.
- `src/accounts.ts` — `resolveAccounts()` builds the `AccountSet` (registry): whole-registry env override via `GOOGLE_ACCOUNTS`, else `config.json`; `getAccountSet()` is the live accessor (dispatch-time readers use it, never a captured snapshot); `invalidateAccountSet()`/`isAccountSetStale()` back the reload path. Token dir defaults to `~/.config/mcp-google-multi/tokens` (override `TOKEN_STORE_PATH`).
- `src/config-file.ts` — `config.json` zod-strict schema (secrets-shaped keys fail), version gate, `mutateConfigFile` read-latest-under-lock writer. `src/fs-atomic.ts` — path-keyed hardlink lock + atomic write (generalized from the token store; token writes delegate to it).
- `src/identity.ts` — `buildIdentityContext(env, {transport})`: the frozen forward-compat seam `{subject, accounts, policy, getClient, tokenStore}` (`subject` is `'owner'` in the free core); `buildRegistry(server, ctx)` consumes it. `index.ts` builds one owner context per transport; `isOwnerContext()` gates host-disk tools and the account wizard.
- `src/migrate-config.ts` — `migrate-config` CLI: env -> `config.json` accounts (idempotent, never edits env).
- `src/tools/_errors.ts` — `mapGoogleError` typed taxonomy + `handleGoogleApiError` result wrapper; each service file defines its own `handle<Service>Error` shim over it (optionally with a service-specific 403 hint).
- `src/tools/_coerce.ts` — `coerceArray`/`coerceJson`/`coerceBoolean` for string-encoded client args.
- `src/scope-observability.ts` — the #114 three-state classifier (callable / requestable_not_granted / not_requestable{add_bundle|account_type|unknown_scope}): joins a method's required scopes (escape hatch: runtime Discovery; generated tools: baked+interned at gen time on `ApiMethodRef.scopes`) against the account's GRANTED token scopes, enriches `insufficient_scope` hints with copy-pasteable remediation and an honest `retriable`. `account_list`'s scopes block is the compact profile∪granted report; the registered-tool universe is doctor's. Also exports `accountScopeSets` (granted and profile scope sets for one account; `ScopeSetDeps` reads a custom token store) and `summarizeToolScopes` (how many registered tools an account can call and which bundle unlocks the rest), behind the `Scopes` line of `doctor` and `config check`.
- `src/executor.ts` — `executeApiMethod`: the shared REST executor for generated tools and `google_api_call` (100k-char response cap).
- `src/arg-normalize.ts` / `src/arg-strict.ts` — transport-level argument handling: snake_case→camelCase key rename (`GOOGLE_ARG_NORMALIZE`, on by default), unknown-argument screening (`GOOGLE_ARG_UNKNOWN=reject|warn|off`, default `reject`), and `withValidationEnvelope` (SDK schema-validation prose → JSON error envelope).
- `src/http-config.ts` — `MCP_TRANSPORT` (`stdio` default | `http` | `both`), `MCP_HTTP_HOST`/`MCP_HTTP_PORT` (127.0.0.1:4243), `MCP_PUBLIC_URL`, `MCP_ALLOWED_ORIGINS`; canonicalizes the advertised resource URI exactly once. `src/http-transport.ts` — `HttpTransportHost`: node:http server, Host/Origin guard, stateless per-request `/mcp` dispatch, mounted AS routes. Stateless HTTP cannot push `tools/list_changed`, so it forces `curated` mode.
- `src/http-confirm.ts`: `HttpConfirm` (the registry's `httpConfirm` field): how an escape-hatch write that needs a human is confirmed over stateless HTTP, where the server cannot ask mid-call. 2026-07-28 revision: an SDK `inputRequired` result (elicit key `confirm`, signed `requestState` bound to the call hash and the subject), served by the second server a lane builds through `ServerTarget.modern`; the client repeats the call with its answer. 2025 revision, only with `MCP_HTTP_CONFIRM_TOKEN` (or `ServerTarget.confirmToken`): refusal `confirmation_required` with a `summary` and a single-use `confirmToken` (`ConfirmTokens`, signed with `MCP_CONFIRM_KEY`, expiry `MCP_CONFIRM_TTL_SECONDS`); the repeat call carries it outside the tool schema, and a changed, reused or expired token is `confirmation_invalid`. stdio keeps live elicitation. User doc: `docs/configuration.md`; rationale: `docs/internals.md`.
- `src/oauth-as.ts` — `buildAuthServer()`: built-in OAuth 2.1 authorization + resource server. Mints its own audience-bound HS256 token for the MCP client, gates on an owner Google login (`MCP_OWNER_EMAILS`; those Google tokens are discarded), keeps per-alias Google tokens separate, and issues signed `alias_reauth` links. `src/mcp-token.ts` — JWT/state/code signing, replay guard, rotated refresh store, keyed by `MCP_JWT_KEY`. `src/cimd-cache.ts` + `src/ssrf-guard.ts` — client-ID metadata document fetch (HTTPS only, private ranges blocked, capped, cached). `src/oauth-consent.ts` — loopback consent on an ephemeral port, shared by `auth --account` and the wizard. `src/reauth-hint.ts` — re-auth hint: the CLI command over stdio, a signed link over HTTP.
- `src/hint-provider.ts` — optional process-global remediation-hint provider (`setHintProvider`/`hints()`), keyed by `HintCase` facts. A single-owner process never installs one, so every call site keeps its literal. `src/boot-gates.ts` / `src/tenant-purge.ts` — multi-tenant boot gates and token-purge primitives; the free core never installs or calls them.
- `src/doctor.ts` — `runDiagnostics()`: one engine, two skins (`doctor` CLI, `diagnose` tool); also the `reset` CLI. `src/api-probe.ts` — doctor's live per-service API-enablement probe.
- `src/tools/account-wizard.ts` — elicitation-driven `account_add` / `account_reauth` / `account_write_config` (cud=read via `CUD_OVERRIDES`, gated by `anthropic/requiresUserInteraction`); owner context only. `src/client-config.ts` — MCP-client detection + idempotent config entry (`write-client-config` CLI); never inlines secrets. `src/setup-prompt.ts` — the `setup` MCP prompt (Google Cloud Console walkthrough).
- `src/usage-metrics.ts` / `src/metrics-tap.ts` / `src/metrics-cli.ts` — local usage metrics, off by default (`GOOGLE_USAGE_METRICS`, `USAGE_METRICS_PATH`); zero egress (import set allowlisted in `tests/usage-metrics.test.ts`), no identity dimensions (it counts protocol revisions as `proto` and clients as `name@major.minor` as `clients`, nothing else about a caller); `metrics` CLI reads the local files. User doc: `docs/usage-metrics.md`.
- `src/registry-transfer.ts` — `account export` / `account import`: passphrase-encrypted bundle of config + still-encrypted token files (never `MASTER_KEY` or the client secret); refuses a tenant-namespaced store.
- `src/env-load.ts` (`.env` loading, real env wins), `src/net-tuning.ts` (raises Node's happy-eyeballs connect timeout), `src/open-url.ts` (best-effort browser launch).
- Public API: the `exports` map in `package.json` is the supported surface for hosts that embed the core (`MIGRATION-v6.md` lists each subpath); `tests/exports-map.test.ts` pins it. A module a host needs must be declared there, and a deep import into `dist/` outside the map is unsupported.

## Adding a tool

```ts
import { <service> as <service>Client } from '@googleapis/<service>';

// inside register<Service>Tools(server, deps: CuratedToolDeps = {}):
const accountEnum = accountArgLive(() => server.accountAliases()).optional();
const getClientFn = deps.getClientFn ?? getClient;

server.registerTool(
  'service_action_name',                 // snake_case, service-prefixed; cud inferred from the verb
  {
    description: '<one sentence; when to use it>',
    inputSchema: {
      account: accountEnum.describe('Google account alias'),   // always first
      // wrap array/object/bool params with coerceArray / coerceJson / coerceBoolean
    },
  },
  async ({ account, /* … */ }) => {
    try {
      const auth = await getClientFn(account as Account);
      const svc = <service>Client({ version: '<v>', auth });
      const res = await svc.<resource>.<method>({ /* … */ });
      return { content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }] };
    } catch (error: any) {
      return handle<Service>Error(error, account as Account);
    }
  },
);
```

**Hard rules:**
- Flat `zod` `inputSchema`; `account` first and OPTIONAL everywhere (sole exception: `drive_transfer` takes `fromAccount`/`toAccount`) — the registry injects the configured default at ONE dispatch site (before write-control and the fan-out parse; not meta-skipped, which is what covers `google_api_call`); omission with no default returns `E_NO_DEFAULT_ACCOUNT`. Coerce array/object/bool inputs — clients send them string-encoded.
- `cud` is inferred from the tool name (no manual flag). CUD tools are auto-gated by write-control; **never** add your own write gate. Fix a misclassified verb in `CUD_OVERRIDES` (`registry.ts`). Two sanctioned exceptions self-check via `isAllowed`: `google_api_call` (per-method cud) and `drive_transfer`'s `move` flag (delete inside a create-classified tool, checked against `registry.policy`).
- Wrap handlers in try/catch → `handle<Service>Error` (→ `mapGoogleError`); errors return `{error, message, hint?, retriable, account}` with `isError: true`. **Never embed the raw error / `error.config` / `error.response`** — token-leak.
- Return `{ content: [{ type: 'text', text: JSON.stringify(...) }] }`.
- Resolve everything through the registry's context: `getClientFn` from the injected `CuratedToolDeps`, account emails from `server.accountSet()`. **Never** read `getAccountSet()`, the token-store module functions or the bare `getClient` from a handler: a registry built over another context would silently use the owner's. A tool that touches the server's disk registers only when `deps.localFiles` allows it.

## Adding a service

1. `src/tools/<service>.ts` exporting `register<Service>Tools(server: ToolRegistry, deps: CuratedToolDeps = {})`.
2. Scopes: always-on → `BASE_SCOPES` in `auth.ts` (breaking — forces re-auth → needs a `BREAKING CHANGE:` footer); optional → a `BUNDLE_CATALOG` entry in `src/scope-catalog.ts` (`OPTIONAL_SCOPE_BUNDLES` in `auth.ts` is derived from it); admin → `ADMIN_SCOPES` (`scope-catalog.ts`, re-exported by `auth.ts`); read-only admin → `ADMIN_READONLY_SCOPES` via the `admin_readonly` catalog entry (per-account, never global; keep `isAdminBundle` in step).
3. Add a `ServiceEntry` to `SERVICES` (`src/services.ts`), with an `enabled()` gate for optional bundles — `buildRegistry()` picks it up.
4. Run `npm run gen:coverage` to regenerate `COVERAGE.md` (never hand-edit it), and update the tool/service counts in `README.md`, `docs/features.md` and the `server.json` description.

## Generated tools (Layer 2)

- `src/tools/generated/*.ts` are EMITTED by `npm run gen:tools` from the `discovery/` snapshot (`npm run gen:discovery` refreshes it) — **never hand-edit**; change `scripts/gen-config.ts` (`CURATED_METHOD_IDS` skip-list, `NAME_`/`CUD_`/`BODY_`/`DESCRIPTION_OVERRIDES`) and regenerate.
- When a new curated tool covers a Discovery method, append the methodId to `CURATED_METHOD_IDS` and regenerate so the generated duplicate disappears; `gen:tools` fails on name collisions with curated tools.
- Generated tools pass an explicit `cud` (derived from HTTP semantics) through the registry config — the only sanctioned use of `config.cud`; curated tools keep name-verb inference.
- They dispatch through `executeApiMethod` (`src/executor.ts`) with method metadata baked at gen time; the escape hatch shares the same executor (no runtime discovery fetch for generated tools).
- A new generated-only service needs: a `GEN_APIS` entry (`scripts/gen-config.ts`), a `BUNDLE_CATALOG` bundle in `scope-catalog.ts` + `GENERATED_GATES` entry in `services.ts` (or ungated when it authorizes via already-granted resource scopes), and a `SUPPORTED_APIS` entry (plus `API_ALIASES` if agents name it differently) in `src/discovery-client.ts` for escape-hatch/policy parity.
- `npm run gen:coverage` regenerates COVERAGE.md from the registry — run it whenever the tool surface changes.

## Auth / tokens

- Tokens are **encrypted at rest** — never write plaintext. `MASTER_KEY` resolves ONLY through `resolveMasterKey()` in `src/master-key.ts` (env > keychain > 0600 file > generate; hard guard: never generate while `<alias>.enc` exist). `MCP_JWT_KEY` (HTTP AS signing key) resolves the same way via `resolveJwtKey()`, without the guard. Never read either env var directly, never log key bytes (provenance label only).
- Always go through the injected `getClientFn(account)` (handles refresh + re-encrypt). Token files are `0600`.
- Secret-injection patterns (why `MASTER_KEY` shouldn't live in `.env` long-term): `docs/secrets.md`.

## Write-control

Reads are never gated. CUD is **deny-by-default**: `GOOGLE_PROFILE` (read-only / safe-writes / full-writes) + `GOOGLE_READ_ONLY` + `GOOGLE_WRITE_ALLOW`/`DENY` globs. Verdict + precedence in `write-control.ts`, tested in `tests/write-control.test.ts`. Patterns match each tool as `service:cud`, `service:op` and `tool:<name>` (exact tool name, globs allowed); only `tool:<name>` singles out a tool named after its own class (`tool:drive_update` leaves `drive_move` alone). User-facing env reference: `docs/configuration.md`.

`safe-writes` is not "cud != delete": `privilegeOf()` also refuses privileged-scope writes (admin/Vault/reseller/script) and push registration (`*_watch`, `*_subscriptions_create|reactivate`), derived from the method's declared scopes and name so it survives regeneration. Pass `scopes` on the `ToolRef` at any new `isAllowed` call site, or the gate silently sees an unprivileged tool. `denyReason()` reports WHICH rule refused (readOnly > deny > allow > profile) and the hint is built from it, so never hand-write a hint that lists settings the verdict did not use.

## Email compose (gmail_send / gmail_create_draft)

Both route through `composeRaw()` in `gmail-mime.ts` (nodemailer MailComposer): header/RFC-2047/address encoding and boundaries are the library's job. A pre-check rejects CR/LF in `from`/`to`/`cc`/`subject` (`E_HEADER_INJECTION`). `attachments` are read by THIS server into buffers (`disableFileAccess`/`disableUrlAccess` on MailComposer), absolute-path-only, basename-guarded, files inside the server's config/token dir refused, total capped at Gmail's ~25 MB message limit once encoded (`E_ATTACHMENT_TOO_LARGE`). Do NOT reintroduce hand-rolled header encoders (they were the injection surface).

## Drive specifics

- Every `fileId` call: `supportsAllDrives: true`; lists: `includeItemsFromAllDrives: true`.
- `drive_upload` `convertTo`: resource mimeType = target `application/vnd.google-apps.*`, media = source. `drive_export` is the reverse.
- Comment text field is `content`. Comments/Replies API requires `fields` on every call (see `*_FIELDS` constants in `drive.ts`).

## Sheets/Docs field masks

`batchUpdate` Request types need explicit `fields` masks — compute from input keys, never wildcards. Helpers `buildCellFormat` / `buildParagraphStyle` / `buildDocumentStyle` are unit-tested in `tests/field-mask-helpers.test.ts`.

## Versioning & releases (automated — CI controls it)

- semantic-release on push to `dev` (alpha) / `staging` (beta) / `main` (stable). Never bump `package.json`, write a changelog, or tag by hand.
- Conventional Commits: `fix:`=patch, `feat:`=minor, a `BREAKING CHANGE:` footer=major. The analyzer's default (angular) preset does NOT parse a bare `feat!:` — a breaking commit MUST carry the footer or it releases nothing. A new `BASE_SCOPES` scope is breaking.
- **Merge commits only** (squash/rebase disabled) — each branch's commits land individually, so keep them clean Conventional Commits.
- After a release, `.github/workflows/backmerge.yml` resyncs the source branch forward: stable = `main → staging + dev`, beta = `staging → dev`. Never start new work on `dev` until the post-promotion backmerge has merged.

## Testing

- `npm run typecheck && npm run lint && npm run test && npm run build` before any PR. CI also runs `node scripts/measure-tools.mjs --check` (lazy `tools/list` byte budget) and `npm run eval:contract` (see `eval/README.md`).
- Unit-test pure logic (write-control verdict, coercion, error mapper, token-store crypto, `inferCud`, field-mask builders). Don't mock the `@googleapis/*` clients — smoke-test handlers against real accounts.

## Don'ts

- No `console.log` from handlers, and nothing may write to stdout at import time either — stdio is the MCP channel (the dotenv v17 banner corrupted it, which is why env loading is the native `process.loadEnvFile` in `src/env-load.ts`; guarded by `tests/stdout-purity.test.ts`). `process.stderr.write` only.
- Don't hardcode aliases — read them from the registry (`server.accountAliases()` / `server.accountSet()`).
- Don't bypass `getClient`; don't write plaintext tokens or perms wider than `0o600`.
- Don't re-implement error mapping or write gating — use the shared helpers.
- Don't add narrative comments — non-obvious WHY only.
