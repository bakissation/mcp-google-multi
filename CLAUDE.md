# Working on mcp-google-multi

Conventions for AI assistants modifying this codebase. v5 is **local, stdio, user-OAuth only**.

## Project shape

- `src/index.ts` — entry. `buildRegistry()` registers every enabled service (the `SERVICES` table, filtered by `GOOGLE_TOOLSETS`), fails fast if `registry.services()` is empty (BEFORE meta tools register — escape tools would mask an empty service set), then `registerDiscoverTools()` + `registerEscapeTools()`; `main()` installs the registry's custom `tools/list` handler and runs the stdio MCP server, or the `auth` / `migrate-tokens` / `config check` CLI commands.
- `src/registry.ts` — `ToolRegistry` wraps the MCP server: records `{name, service, cud, description, inputShape, meta}` per tool, derives `cud` (read/create/update/delete) from the tool name via `inferCud`, **enforces write-control** by wrapping every CUD handler, injects computed annotations (`readOnlyHint`/`destructiveHint`), and owns **discover-first visibility**: all tools register eagerly (always callable — graceful dispatch), but the custom `tools/list` handler only advertises meta tools + `reveal()`ed services. `installListHandler()` must run after registration, before connect. Service files still call `server.registerTool(...)` — `server` is now a `ToolRegistry`.
- `src/discover.ts` — `registerDiscoverTools()`: one eager `{service}_discover` meta-tool per service; returns the catalog (`registry.catalog`), reveals the service, triggers `tools/list_changed`. Never emit `tool_reference` content blocks or top-level `defer_loading` fields — strict SDK clients reject/strip them (verified against SDK 1.29).
- `src/toolsets.ts` — `GOOGLE_TOOLSETS` parsing (`all` | CSV of service names).
- `src/discovery-client.ts` — runtime Google API Discovery: `loadMethodIndex(api)` fetches `https://www.googleapis.com/discovery/v1/apis/{id}/{version}/rest` on demand, disk-caches 7 days (`DISCOVERY_CACHE_PATH`), stale-if-offline; `cudFromMethod` (HTTP verb → cud, POST read-verbs like batchGet → read), `expandPath` ({param} + {+param} templates), `searchMethods`. Deps injectable for tests — never hit the network in unit tests.
- `src/tools/google-api.ts` — `registerEscapeTools()`: eager `google_api_search` + `google_api_call`. The call tool enforces write-control ITSELF (its registry cud is read, so the wrapper doesn't gate it) via `isAllowed` on the method's derived cud — keep that check when touching this file.
- `src/write-control.ts` — `resolvePolicy()` (env → policy) + `isAllowed()` (deny-by-default verdict) + `config check` rendering.
- `src/token-store.ts` — encrypted token store (AES-256-GCM, key from `MASTER_KEY`); `readToken`/`writeToken` + the `migrate-tokens` source.
- `src/auth.ts` — OAuth flow + scope tiers (`BASE_SCOPES` always, `OPTIONAL_SCOPE_BUNDLES` env-gated, `ADMIN_SCOPES` per-account).
- `src/client.ts` — `getClient(account)`: cached OAuth2Client from the encrypted token; refreshes + re-encrypts.
- `src/accounts.ts` — parses `GOOGLE_ACCOUNTS`; token dir defaults to `~/.config/mcp-google-multi/tokens` (override `TOKEN_STORE_PATH`).
- `src/tools/_errors.ts` — `mapGoogleError` typed taxonomy + per-service `handle<Service>Error` shims.
- `src/tools/_coerce.ts` — `coerceArray`/`coerceJson`/`coerceBoolean` for string-encoded client args.

## Adding a tool

```ts
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
      const auth = await getClient(account as Account);
      const svc = google.<service>({ version: '<v>', auth });
      const res = await svc.<resource>.<method>({ /* … */ });
      return { content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }] };
    } catch (error: any) {
      return handle<Service>Error(error, account as Account);
    }
  },
);
```

**Hard rules:**
- Flat `zod` `inputSchema`; `account` first. Coerce array/object/bool inputs — clients send them string-encoded.
- `cud` is inferred from the tool name (no manual flag). CUD tools are auto-gated by write-control; **never** add your own write gate. Fix a misclassified verb in `CUD_OVERRIDES` (`registry.ts`).
- Wrap handlers in try/catch → `handle<Service>Error` (→ `mapGoogleError`); errors return `{error, message, hint?, retriable, account}` with `isError: true`. **Never embed the raw error / `error.config` / `error.response`** — token-leak.
- Return `{ content: [{ type: 'text', text: JSON.stringify(...) }] }`.

## Adding a service

1. `src/tools/<service>.ts` exporting `register<Service>Tools(server: ToolRegistry)`.
2. Scopes in `auth.ts`: always-on → `BASE_SCOPES` (breaking — forces re-auth → `feat!:`); optional → `OPTIONAL_SCOPE_BUNDLES`; admin → `ADMIN_SCOPES`.
3. Wire into `buildRegistry()` (`index.ts`).
4. Update `COVERAGE.md` + `README.md`.

## Auth / tokens

- Tokens are **encrypted at rest** — never write plaintext. `MASTER_KEY` is required; it lives only in env (never in the store, never logged).
- Always go through `getClient(account)` (handles refresh + re-encrypt). Token files are `0600`.

## Write-control

Reads are never gated. CUD is **deny-by-default**: `GOOGLE_PROFILE` (read-only / safe-writes / full-writes) + `GOOGLE_READ_ONLY` + `GOOGLE_WRITE_ALLOW`/`DENY` globs. Verdict + precedence in `write-control.ts`, tested in `tests/write-control.test.ts`.

## Drive specifics

- Every `fileId` call: `supportsAllDrives: true`; lists: `includeItemsFromAllDrives: true`.
- `drive_upload` `convertTo`: resource mimeType = target `application/vnd.google-apps.*`, media = source. `drive_export` is the reverse.
- Comment text field is `content`. Comments/Replies API requires `fields` on every call (see `*_FIELDS` constants in `drive.ts`).

## Sheets/Docs field masks

`batchUpdate` Request types need explicit `fields` masks — compute from input keys, never wildcards. Helpers `buildCellFormat` / `buildParagraphStyle` / `buildDocumentStyle` are unit-tested in `tests/field-mask-helpers.test.ts`.

## Versioning & releases (automated — CI controls it)

- semantic-release on push to `dev` (alpha) / `staging` (beta) / `main` (stable). Never bump `package.json`, write a changelog, or tag by hand.
- Conventional Commits: `fix:`=patch, `feat:`=minor, `feat!:`/`BREAKING CHANGE:`=major. A new `BASE_SCOPES` scope is breaking (`feat!:`).
- **Merge commits only** (squash/rebase disabled) — each branch's commits land individually, so keep them clean Conventional Commits.
- After a stable release, `.github/workflows/backmerge.yml` resyncs `main → staging → dev`.

## Testing

- `npm run typecheck && npm run lint && npm run test && npm run build` before any PR.
- Unit-test pure logic (write-control verdict, coercion, error mapper, token-store crypto, `inferCud`, field-mask builders). Don't mock `googleapis` — smoke-test handlers against real accounts.

## Don'ts

- No `console.log` from handlers (stdio is the MCP channel) — `process.stderr.write` only.
- Don't hardcode aliases — read `ACCOUNTS` / `ACCOUNT_CONFIG`.
- Don't bypass `getClient`; don't write plaintext tokens or perms wider than `0o600`.
- Don't re-implement error mapping or write gating — use the shared helpers.
- Don't add narrative comments — non-obvious WHY only.
