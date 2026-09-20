# Implementation notes

Contributor-facing rationale for non-obvious implementation choices — why the code is the way it is, not how to use it. Back to the [README](../README.md).

## Token store

### Windows rename retry (`renameWithRetry`, `src/token-store.ts`)

`renameWithRetry` exists because Windows uses classic rename semantics (`MoveFileExW` without POSIX semantics): replacing a token file that another process momentarily holds open — a concurrent `readToken`, an antivirus scanner, or a search indexer — fails with a transient `EPERM`, `EACCES`, or `EBUSY`. Reads deliberately take no lock, so the token write lock cannot prevent this collision; a short bounded retry (`RENAME_ATTEMPTS` with linear backoff) absorbs it instead. POSIX rename never fails this way, so the retry loop is effectively inert on Linux and macOS.

## Admin SDK

### Why admin tools are per-account opt-in (`ADMIN_SCOPES`, `src/auth.ts`)

The Admin SDK requires a Workspace account with admin privileges; consumer @gmail.com accounts always get a 403. Strictly speaking, the only person with admin rights over a @gmail.com account is a Corporate Operations Engineer on Google's internal Techstop helpdesk — and if that's you, an MCP server is really not how you should be doing this. Requesting admin scopes on an account that cannot use them would only add consent-screen noise, so `GOOGLE_ADMIN_ACCOUNTS` grants them per-account instead of globally.

## Networking

### Why the server raises Node's happy-eyeballs timeout (`applyNetTuning`, `src/net-tuning.ts`)

Node enables Happy Eyeballs (`autoSelectFamily`) by default since v20 and gives each address-family connect attempt 250ms (`autoSelectFamilyAttemptTimeout`). On a high-latency link to a distant Google edge, or when the ISP router advertises a dead IPv6 route, that budget aborts the IPv6 attempt *and* the IPv4 attempt, so every Google call fails with `ETIMEDOUT` while `curl` (which waits normally) works. Node itself raised the default to 500ms ([nodejs/node#60334](https://github.com/nodejs/node/pull/60334)) but only from v25.2; every LTS line this package supports ships 250ms, and the real fix (RFC 8305 parallel attempts, [nodejs/node#48145](https://github.com/nodejs/node/issues/48145)) is still open. The server therefore raises the process-wide default to 2000ms at startup. The trade-off is a slower failover when one address family hangs rather than fails fast — acceptable for a personal MCP server, not worth per-request agent plumbing through gaxios and undici. The tuning is skipped whenever the user passes `--network-family-autoselection-attempt-timeout` or `--no-network-family-autoselection` (via CLI or `NODE_OPTIONS`), and it never lowers a value that is already at or above 2000ms.

### How the section-6 API-enablement probe picks its reads (`API_PROBES`, `src/api-probe.ts`)

Probes are selected by the **granted scopes** on the probed account, not by the registered services: probing an ungranted service can only produce `insufficient_scope`, which says nothing about enablement. Services with no no-argument read (Sheets, Docs, Forms) are probed with a GET on a nonexistent id — Google checks `accessNotConfigured`/`SERVICE_DISABLED` before routing, so a 404 still proves the API is enabled. Admin SDK is deliberately unprobed (role-dependent: a 403 on a non-admin account is ambiguous). A connect-level failure aborts the run so section 6 reports one WARN with the syscall code instead of a column of unknowns. The probe uses `getClient`, so an expired-refreshable token may refresh and re-encrypt on disk — the same cache write every tool call performs; BR7's "no mutation" bars config/token *destruction*, not the refresh path.

### Why connect failures get their own `network_error` envelope (`netCodeOf`, `src/tools/_errors.ts`)

The Google API path is gaxios → node-fetch → `node:https`. When the happy-eyeballs `AggregateError` (whose `message` is empty) reaches node-fetch, its `FetchError` keeps only the `code`/`syscall` and discards the error object, producing the famously unhelpful `request to <url> failed, reason: ` with the real signal hiding in `error.code`. `mapGoogleError` previously fed `error.code` through `Number()` (built for HTTP statuses), so `ETIMEDOUT` was dropped and the envelope said `upstream_error, retriable: false` — wrong on both counts. `netCodeOf` walks the cause chain (GaxiosError → FetchError; undici `TypeError` → `AggregateError.errors`) for known connect/DNS syscall codes and returns a `network_error` envelope that names the code, marks transient codes retriable, and points at the happy-eyeballs flag. Per-address sub-errors are only available on undici call sites; node-fetch destroys them upstream.

## Executor

### Request bodies on GET/HEAD (`resolveRequestBody`, `src/executor.ts`)

`executeApiMethod` strips request bodies from GET/HEAD requests before dispatch:

- gaxios stringifies any object passed as `data` without checking the HTTP verb, and undici (Node's `fetch`) rejects GET/HEAD requests that carry a body (`Request with GET/HEAD method cannot have body`). A caller-supplied `{}` body on a read tool would therefore crash the request.
- Stripping is lossless: no Google Discovery GET/HEAD method declares a request schema, so there is never a legitimate GET/HEAD body to preserve.
- Write verbs keep the usual semantics: `null`/`undefined` means no body is sent.

## Argument normalization

`src/arg-normalize.ts` renames snake_case `tools/call` argument keys to their declared camelCase twins (e.g. `thread_id` → `threadId`) before SDK validation, at the transport `onmessage` seam. The seam is deliberate: the SDK advertises an EMPTY input schema in `tools/list` for any non-object schema wrapper (pipe/preprocess), so schema-level normalization would blank every tool's advertised parameters, while the JSON-RPC message shape is versioned MCP spec. The rename is lossless by construction (sent key unknown to the schema, camel twin declared, twin not also sent) and each one logs key names — never values — to stderr. Because clients string-encode values for keys absent from the advertised schema, a renamed key's value is also coerced to the declared scalar kind when it parses cleanly (`"2"` → `2` for a number field, `"true"` → `true` for a boolean); declared keys' values are never touched. `GOOGLE_ARG_NORMALIZE=off` disables it.
