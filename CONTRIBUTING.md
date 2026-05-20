# Contributing to mcp-google-multi

Thanks for your interest in contributing! This is an MCP server exposing Gmail, Drive, Calendar, Sheets, Docs, Contacts, Search Console, Tasks, Meet, Forms, Chat, Admin SDK, and Alert Center tools with multi-account OAuth.

## Branching model

This repo uses a three-tier promotion flow:

```
your fork ──PR──▶ dev ──▶ staging ──▶ main (releases tagged here)
                  ▲         (maintainer-promoted)
            contributors
            target dev
```

- **Open all PRs against `dev`.** PRs to `staging` or `main` from contributors will be redirected.
- The maintainer promotes `dev → staging → main` and cuts releases from `main`.
- `dev`, `staging`, and `main` are all protected: CI must pass and changes land via pull request.

## Dev setup

```bash
git clone https://github.com/bakissation/mcp-google-multi.git
cd mcp-google-multi
npm install
cp .env.example .env          # add your GOOGLE_CLIENT_ID/SECRET and GOOGLE_ACCOUNTS
npm run build
node dist/index.js auth --account <alias>   # OAuth each account you'll test with
```

You need a Google Cloud project with the relevant APIs enabled and an OAuth 2.0 Desktop client — see the README "Setup" section.

**Never commit `.env` or anything under `tokens/`** (both are gitignored). Don't paste tokens, client secrets, or OAuth codes into issues or PRs.

## Before you open a PR

All of these must pass:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

## Conventions

The full spec lives in [`CLAUDE.md`](./CLAUDE.md). The essentials:

- **One service per file** in `src/tools/<service>.ts`, exporting `register<Service>Tools(server)`.
- **Tool shape:** `server.registerTool(name, { description, inputSchema }, handler)`. `inputSchema` is a flat `zod` object with `account: accountEnum` as the first field. Tool names are `snake_case`, prefixed by service.
- **Errors:** wrap handlers in `try/catch` and delegate to the per-service `handle<Service>Error` shim (which calls `handleGoogleApiError`). Set `isError: true` on error responses.
- **Scopes** are tiered in `src/auth.ts`: `BASE_SCOPES` (always), `OPTIONAL_SCOPE_BUNDLES` (env opt-in), `ADMIN_SCOPES` (per-account opt-in). Any new scope must be documented and noted as requiring re-auth.
- **No `console.log`** in tool handlers — stdio is the MCP channel; use `process.stderr.write` if needed.
- **Tests:** pure-logic helpers get unit tests (`vitest`). Handlers are verified by manual smoke testing — we do not mock `googleapis`.

## Commits & versioning

Versioning and releases are **fully automated** by [semantic-release](https://semantic-release.gitbook.io/) from your commit messages — **do not bump `package.json` or edit a changelog by hand.** Just write good [Conventional Commits](https://www.conventionalcommits.org/):

- `fix:` → patch, `feat:` → minor, `feat!:` / `BREAKING CHANGE:` → major. `docs:`/`chore:`/`refactor:` don't trigger a release.
- On merge, a release is cut automatically per channel: **`dev` → `x.y.z-alpha.n`**, **`staging` → `x.y.z-beta.n`**, **`main` → `x.y.z`** (stable). Release notes are generated into [GitHub Releases](https://github.com/bakissation/mcp-google-multi/releases).
- Still update the relevant **README** tables in your PR when you add/change a tool. (`package.json` `version` is a managed placeholder — the git tag / GitHub Release is the source of truth.)

## PR checklist

- [ ] Targets `dev`
- [ ] `typecheck`, `lint`, `test`, `build` all pass
- [ ] Conventional commit messages
- [ ] README tables updated (no manual version bump / changelog — automated from your commits)
- [ ] No secrets, tokens, or `.env` committed

## Security

Do **not** report vulnerabilities in public issues. See [`SECURITY.md`](./SECURITY.md).
