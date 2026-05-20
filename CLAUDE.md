# Working on mcp-google-multi

Conventions for AI assistants modifying this codebase.

## Project shape

- Each Google service lives in `src/tools/<service>.ts` and exports `register<Service>Tools(server: McpServer): void`.
- `src/index.ts` is the entry point. It wires service registrations into the MCP server, conditional on env-driven scope bundles (Forms/Chat/Alert Center opt-in, Admin opt-in per-account).
- `src/auth.ts` owns OAuth flow + scope tier resolution. `BASE_SCOPES` are always granted; `OPTIONAL_SCOPE_BUNDLES` are env-gated; `ADMIN_SCOPES` are per-account-gated. `resolveScopesForAccount(alias)` is the authoritative composer.
- `src/client.ts` is a thin OAuth2Client factory used by every tool handler.
- `src/accounts.ts` parses the `GOOGLE_ACCOUNTS` env var.

## Adding a new tool

Every tool follows the same skeleton:

```ts
server.registerTool(
  'service_action_name',                       // snake_case, prefixed by service
  {
    description: '<one sentence; explain when to use this tool>',
    inputSchema: {
      account: accountEnum.describe('Google account alias'),  // always first
      // ...other params as a flat zod object
    },
  },
  async ({ account, /* destructure inputs */ }) => {
    try {
      const auth = await getClient(account as Account);
      const svc = google.<service>({ version: '<v>', auth });
      const res = await svc.<resource>.<method>({ /* params */ });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
      };
    } catch (error: any) {
      return handle<Service>Error(error, account as Account);
    }
  },
);
```

**Hard rules:**
- `inputSchema` is a flat object of `zod` schemas. Do not nest into another `z.object` at the top level.
- `account: accountEnum` is the first field of every input schema.
- Wrap the handler body in try/catch. Call the file's `handle<Service>Error` helper in the catch.
- Return `{ content: [{ type: 'text' as const, text: JSON.stringify(...) }] }`. Stringify the response payload so MCP clients can re-parse it.
- For errors, also set `isError: true`.
- Every file has a 3-line `handle<Service>Error` shim at the bottom that delegates to `handleGoogleApiError` in `src/tools/_errors.ts` — the shared 401/403/429/fallback mapper. Pass an optional service-specific `forbiddenHint` string to the shared helper for services where 403 has a known fix (e.g. admin scopes, optional scope bundle not enabled).

## Adding a new service

1. Create `src/tools/<service>.ts` exporting `register<Service>Tools(server)`.
2. Add scope(s) to `src/auth.ts`:
   - Always-on → append to `BASE_SCOPES`.
   - Optional bundle → add a new key to `OPTIONAL_SCOPE_BUNDLES`.
   - Admin-only → append to `ADMIN_SCOPES`.
3. Wire registration in `src/index.ts`. Always-on calls go in the unconditional block; optional bundles check `optional.has('<key>')` (where `optional` is built from `getOptionalBundles()`); admin tools register only if `getAdminAccounts().length > 0`.
4. Update README scope table, tool table, and tool count in the Features bullet.
5. Update CHANGELOG.md.

## Drive-specific: shared drive support

Every Drive API call that takes a `fileId` must pass `supportsAllDrives: true`. List operations also need `includeItemsFromAllDrives: true`. Forgetting these silently breaks shared-drive content. Existing tools already have them — preserve when refactoring.

## Sheets/Docs: fields masks

`spreadsheets.batchUpdate` Request types like `RepeatCell` and `updateParagraphStyle` require explicit `fields` masks. Compute the mask from supplied input keys; never use wildcards. The helpers `buildCellFormat` (in `sheets.ts`), `buildParagraphStyle`, and `buildDocumentStyle` (in `docs.ts`) are the reference implementations and are unit-tested in `tests/field-mask-helpers.test.ts`. If you add a new format dimension, extend the helper, add a test, and bump the input schema.

## Escape hatches

`sheets_batch_update` and `docs_batch_update` accept the full Request union as `z.array(z.record(z.string(), z.any()))`. Don't add a per-Request-type tool unless it's high-frequency or has a high-value default-computing facade (like `format_cells`). The catch-all keeps the tool count tractable.

## Comments / Replies (Drive)

- Comment text field is `content`, not `body`. Confirmed against the Drive v3 Comment resource.
- `replies.create` accepts `action: 'resolve' | 'reopen'` to close/reopen a thread in the same call.
- Comments/Replies API **requires** the `fields` query param on every call — never omit. See the `COMMENT_FIELDS`, `COMMENT_LIST_FIELDS`, `REPLY_FIELDS`, `REPLY_LIST_FIELDS` constants at the top of `drive.ts`.

## Admin SDK safety

- Admin tools only register if `GOOGLE_ADMIN_ACCOUNTS` is set.
- Destructive admin writes (`admin_users_update`) must check `adminWritesEnabled()` (imported from `auth.ts`) and refuse if `GOOGLE_ALLOW_ADMIN_WRITES` is not exactly `'true'`. Do not relax this gate.
- Admin tools 403 on personal Gmail accounts. The `handleAdminError` helper surfaces this hint clearly — keep it.

## Alert Center is NOT an admin scope

- `apps.alerts` (Alert Center) is **not** in `ADMIN_SCOPES`. Google does not grant it through the interactive user-consent OAuth flow this server uses — it requires a service account with domain-wide delegation. Putting it in the user-OAuth admin bundle made the *entire* admin consent fail with `Error 400: invalid_scope`.
- It lives in the `alertcenter` key of `OPTIONAL_SCOPE_BUNDLES`, and `registerAlertCenterTools` (in `admin.ts`) registers behind `optional.has('alertcenter')` — never behind `getAdminAccounts()`. Keep these decoupled so a missing/ungrantable `apps.alerts` can never block the working Admin SDK tools.
- Until service-account + domain-wide-delegation auth exists, the `alertcenter` bundle is declared-but-non-functional under user OAuth. `handleAlertCenterError` surfaces this — keep the hint.

## Versioning

- Manual semver in `package.json`.
- Release commit message format: `chore(release): X.Y.Z` (lowercase, matches existing history).
- Tag: `vX.Y.Z`.
- New OAuth scopes in `BASE_SCOPES` = major version bump (tokens become incomplete, requires re-auth).
- New tools / new optional bundles / new admin scopes = minor version bump.
- Bug fixes = patch.

## Testing

- `npm run typecheck && npm run lint && npm run test` must all pass before any PR.
- Pure-logic helpers (fields-mask builders, validation helpers) get unit tests.
- Do not try to mock `googleapis` for integration tests — manual smoke testing in Claude Code against real accounts is the truth.
- Always re-auth after editing `BASE_SCOPES` before manual testing.

## Don'ts

- Don't `console.log` from tool handlers in MCP server mode. Stdio is the MCP channel. Use `process.stderr.write` if you really need to.
- Don't hardcode account aliases. Always read from `ACCOUNTS` / `ACCOUNT_CONFIG`.
- Don't bypass `getClient(account)` — it handles token refresh persistence.
- Don't store tokens with permissions wider than `0o600`.
- Don't expand `BASE_SCOPES` silently. Any scope change is user-visible and requires CHANGELOG documentation + a re-auth note.
- Don't re-implement error mapping. Always go through `handleGoogleApiError` (via the per-service shim).
- Don't re-parse `GOOGLE_OPTIONAL_SCOPES` or `GOOGLE_ADMIN_ACCOUNTS` inline. Use `getOptionalBundles()` / `getAdminAccounts()` exported from `auth.ts`.
- Don't add narrative comments explaining WHAT code does. The CLAUDE.md rule is non-obvious WHY only; section dividers (`// ─── X ───`) are the exception as navigation aids.
