# mcp-google-multi

The most complete **local Google Workspace MCP server**: Gmail, Drive, Calendar, Sheets, Docs, Slides, Forms, Contacts, Tasks, Chat, Meet, Analytics (GA4), Search Console, Classroom, Vault, Admin and more — **every OAuth-reachable API method** as a tool, across **multiple Google accounts** at once, from Claude Code or any MCP client.

[![npm](https://img.shields.io/npm/v/mcp-google-multi?label=npm&color=cb3837)](https://www.npmjs.com/package/mcp-google-multi)

- 🧰 **Exhaustive** — 940 tools across 29 services, now including Google Analytics (GA4), + an escape hatch for anything else → [COVERAGE.md](./COVERAGE.md)
- 🔑 **Multi-account** — drive any number of Google accounts by alias, or fan one call out across all of them
- 🔒 **Private by design** — your own OAuth app, tokens encrypted at rest (AES-256-GCM), writes deny-by-default, no telemetry, no metering — it talks only to Google
- 🌐 **Local or remote** — runs locally over stdio, or self-hosted over HTTP with its own built-in OAuth 2.1 server (Claude Code's `/mcp` login and the claude.ai connector, zero custom UI). Pull-and-up Docker Compose with optional automatic HTTPS → [remote setup](./docs/http-setup.md)
- ✉️ **Built for real work** — send and read email in Markdown with attachments and one-call replies, an interactive setup wizard with a `doctor` self-check, and per-account scope profiles → [features tour](./docs/features.md)

## Quick setup

New to all this? It's written for someone who just installed Claude Code and has never made an API key. Copy-paste each step; it says what you'll see. (Already technical? The [Configuration reference](./docs/configuration.md) is the terse version.)

1. **Install it.** Get [Node.js](https://nodejs.org) (the green "LTS" button, version 22 or newer), then run:

   ```bash
   npm install -g mcp-google-multi
   ```

2. **Make your Google key** (the one manual part, a few minutes, because Google has no way to script it). Follow the step-by-step [Google Cloud setup](./docs/google-cloud-setup.md), or just ask Claude Code: *"walk me through creating a Google OAuth Desktop client for mcp-google-multi."* You finish with two values, a **Client ID** and a **Client Secret**. It's free and private to you.

3. **Put them in a file.** In the folder you'll run from, make a file named `.env` and paste this, filling in your values:

   ```bash
   GOOGLE_CLIENT_ID=paste-your-client-id
   GOOGLE_CLIENT_SECRET=paste-your-client-secret
   # any short nickname, then your Gmail address:
   GOOGLE_ACCOUNTS=me:you@gmail.com
   ```

   No encryption key to make: the server generates and stores one for you.

4. **Sign in.** A browser opens; pick your account and click Allow:

   ```bash
   mcp-google-multi auth --account me
   ```

5. **Add it to Claude Code, then restart Claude Code:**

   ```bash
   claude mcp add google-multi -s user -- npx -y mcp-google-multi
   ```

**Stuck at any point? Run `mcp-google-multi doctor`.** It inspects every part and prints the exact fix for anything wrong (a missing sign-in, a Google API you still need to switch on, and so on). Once it reads all-green, just talk to Claude: *"summarize my unread email."*

*Got more than one Google account?* Add them together, like `GOOGLE_ACCOUNTS=me:you@gmail.com,work:you@company.com`, and run step 4 once per nickname.

*On a server or from claude.ai?* Advanced path: [Remote / HTTP setup](./docs/http-setup.md). *Coming from v5?* [v6 migration guide](./MIGRATION-v6.md).

**Go deeper:** [Configuration reference](./docs/configuration.md) · [What's covered](./COVERAGE.md) · [Features tour](./docs/features.md) · [Remote / HTTP setup](./docs/http-setup.md) · [Secrets in a vault](./docs/secrets.md) · [Migrating to v6](./MIGRATION-v6.md) · [Security policy](./SECURITY.md) · [Roadmap](https://github.com/bakissation/mcp-google-multi/milestones)

## Maintainer & credits

Built and maintained by **Abdelbaki Berkati** — [berkati.xyz](https://berkati.xyz) · [@bakissation](https://github.com/bakissation). [Read the case study →](https://berkati.xyz/case-studies/mcp-google-multi/)

Development is **funded by [IdeaCrafters](https://ideacrafters.com)** ([@IdeaCraftersHQ](https://github.com/IdeaCraftersHQ)) — the studio that pays for this OSS to exist.

Thanks to contributors [@obatried](https://github.com/obatried), [@trevor-commits](https://github.com/trevor-commits), and [@mjreddy](https://github.com/mjreddy). The project is maintainer-led (roadmap on [Milestones](https://github.com/bakissation/mcp-google-multi/milestones); bug reports welcome, feature PRs by prior agreement — see [CONTRIBUTING.md](./CONTRIBUTING.md)). **Feedback shapes the roadmap: [open an issue](https://github.com/bakissation/mcp-google-multi/issues/new/choose) with bugs, pain points, or what you wish it did.** Security reports go to [SECURITY.md](./SECURITY.md), never a public issue.

## License

[MIT](./LICENSE)
