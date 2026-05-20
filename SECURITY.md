# Security Policy

## Supported versions

This project follows semantic versioning. Security fixes are applied to the **latest released minor version** only. Please upgrade before reporting.

## Reporting a vulnerability

**Do not open a public issue or pull request for security vulnerabilities.**

Report privately via GitHub's **Private Vulnerability Reporting**:

1. Go to the [Security tab](https://github.com/bakissation/mcp-google-multi/security) of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, affected version, and reproduction steps.

You'll get an acknowledgement and can track the fix in the private advisory. Once a fix ships, the advisory is published with credit (unless you prefer to remain anonymous).

## Why this matters here

This server brokers OAuth access to Google accounts — Gmail, Drive, Calendar, and (when enabled) Workspace **Admin SDK** scopes. A vulnerability could expose mail, files, or directory data. Of particular interest:

- **Token handling** — tokens live under `tokens/<alias>/token.json` (mode `0600`) and must never be logged or transmitted.
- **Header / MIME construction** — Gmail tools build raw RFC 5322 messages; injection (e.g. CRLF in headers) is in scope.
- **Scope escalation** — anything that grants an account scopes it didn't consent to.

## Out of scope

- Vulnerabilities requiring an already-compromised local machine or a maliciously modified `.env`.
- Issues in Google's own APIs (report those to Google).

## Good hygiene for everyone

Never paste OAuth tokens, client secrets, authorization codes, or `.env` contents into issues, PRs, or logs.
