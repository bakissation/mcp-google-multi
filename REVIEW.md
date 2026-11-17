# Review guide

For anyone reviewing a change to this repo, human or AI. Reviewers read this file from the base branch, so a pull request cannot change the rules it is reviewed under. Changes to this file get their own review.

## How to report

- Review a named commit SHA and say which one.
- Give `file:line`, a concrete failure scenario (input or state, then wrong result), and why it matters. A finding without a scenario is a question, not a finding.
- Explain why you flag something. Say what you checked and could not confirm.
- One finding per issue. Put the most severe first.

## Severity

- **must-fix**: blocks the merge. A security or data-exposure flaw, a write that bypasses write control, a broken public API or tool schema, a crash or data loss on a normal path, a flag with an untested side.
- **should-fix**: real defect or gap with limited reach. Fix before merge unless the author gives a reason.
- **nit**: style or wording a maintainer may take or leave. Never blocks.
- **pre-existing**: a problem the change did not introduce. Report it separately; it does not block this change.

## What to check

Security-sensitive areas. Treat any change here as must-fix territory until shown safe.

- **Tokens and keys** (`src/token-store.ts`, `src/master-key.ts`, `src/mcp-token.ts`): refresh tokens stay encrypted at rest, keys and tokens are never logged, returned or put in an error. Error payloads carry a message and a code, never a raw error object (it can hold the `Authorization` header).
- **Write control** (`src/write-control.ts`, the wrapper in `src/registry.ts`): writes are denied by default. Tools never add their own write gate; the two sanctioned self-checks are the escape hatch and the move flag of `drive_transfer`. A new `isAllowed` call site passes the tool's scopes. Check that a new verb gets the right `cud` class.
- **Approval marks and irreversible tools**: a new tool that deletes or cannot be undone is listed in `IRREVERSIBLE_TOOLS`.
- **Outbound requests** (`src/ssrf-guard.ts`, `src/outbound-allowlist.ts`): no fetch to a user-supplied URL without the guard, no private, loopback or link-local target, redirects re-checked.
- **Host file access** (`src/tools/_local-files.ts`): a tool that reads or writes the server's disk registers only when local files are allowed, and paths stay inside the configured root.
- **Scopes** (`src/auth.ts`, `src/scope-catalog.ts`): a new scope is justified, put in the right tier, documented, and noted as needing re-auth. No change widens what an account already consented to.
- **Log and error output**: no secrets, tokens, message bodies or addresses in logs. Nothing on stdout in stdio mode (it is the protocol channel); use stderr.
- **Account isolation**: handlers use the injected client factory and the registry's account set, never the module-level getters, so one context cannot reach another's accounts. Fan-out stays read-only.
- **Remote HTTP mode** (`src/http-transport.ts`, `src/oauth-as.ts`): the owner gate and the Host and Origin checks stay in front of every endpoint.
- **Mail construction** (`src/tools/gmail-mime.ts`): header and MIME injection (CRLF in any header value).

Stability and completeness.

- **Public API**: modules in the `exports` map keep their signatures, or the change is called out in the PR and `MIGRATION-v6.md`.
- **Tool schemas**: flat `zod` input, optional `account` first, `snake_case` names with a service prefix. Renaming or removing a field or tool is a breaking change.
- **Tests**: pure-logic changes have unit tests. Every flag and profile is tested on both sides (on and off, allowed and denied). Handlers are smoke-tested, not mocked.
- **Docs and release effects**: the commit type matches the change (`fix:` patch, `feat:` minor, a `BREAKING CHANGE:` footer for a breaking one; `docs:`, `chore:` and `refactor:` do not release). A changed tool surface means `COVERAGE.md` regenerated and the counts in the docs updated. Behaviour changes update `docs/features.md` or `docs/internals.md`. No hand-edited version or changelog.

## Ignore

- Formatting, import order and anything the linter or formatter owns.
- Generated files (`src/tools/generated/`, `COVERAGE.md`): review the generator, not the output.
- Lockfile churn, unless a dependency was added, removed or changed; then check the new package and its install scripts.
- Wording preferences in comments and docs that are already clear.
