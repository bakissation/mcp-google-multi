# Security Policy

## Supported versions

This project follows semantic versioning. Please upgrade before reporting.

| Version | npm dist-tag | Security fixes |
|---|---|---|
| 6.0.x (latest stable minor) | `latest` | yes |
| 5.4.x | — | critical fixes only |
| < 5.4 | — | no |
| 6.x prereleases | `staging` (beta), `dev` (alpha) | in the next prerelease only; earlier prereleases are not patched |

## Reporting a vulnerability

**Do not open a public issue or pull request for security vulnerabilities.**

Report privately via GitHub's **Private Vulnerability Reporting**:

1. Go to the [Security tab](https://github.com/bakissation/mcp-google-multi/security) of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, affected version, and reproduction steps.

You'll get an acknowledgement and can track the fix in the private advisory. Once a fix ships, the advisory is published with credit (unless you prefer to remain anonymous).

## Why this matters here

This server brokers OAuth access to Google accounts — Gmail, Drive, Calendar, and (when enabled) Workspace **Admin SDK** scopes. A vulnerability could expose mail, files, or directory data. Of particular interest:

- **Token handling** — refresh tokens are **AES-256-GCM encrypted at rest** (`~/.config/mcp-google-multi/tokens/<alias>.enc`, mode `0600`) with a key derived from `MASTER_KEY`; tokens must never be logged or transmitted, and `MASTER_KEY` must never be committed or logged. Error payloads carry only `message` + code — never raw error objects (which can hold the `Authorization` header).
- **Header / MIME construction** — Gmail tools build raw RFC 5322 messages; injection (e.g. CRLF in headers) is in scope.
- **Scope escalation** — anything that grants an account scopes it didn't consent to.
- **Remote HTTP mode (v6, opt-in)** — the built-in OAuth authorization server, the `MCP_OWNER_EMAILS` owner gate, and the Host/Origin guard on `/mcp` and the OAuth endpoints.

## Out of scope

- Vulnerabilities requiring an already-compromised local machine or a maliciously modified `.env`.
- Issues in Google's own APIs (report those to Google).

## Good hygiene for everyone

Never paste OAuth tokens, client secrets, `MASTER_KEY`, authorization codes, or `.env` contents into issues, PRs, or logs.
