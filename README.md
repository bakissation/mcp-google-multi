# mcp-google-multi

The most complete **local Google Workspace MCP server**: Gmail, Drive, Calendar, Sheets, Docs, Slides, Forms, Contacts, Tasks, Chat, Meet, Classroom, Vault, Admin and more — **every OAuth-reachable Workspace API method** as a tool, across **multiple Google accounts** at once, from Claude Code or any MCP client.

[![npm](https://img.shields.io/npm/v/mcp-google-multi?label=npm&color=cb3837)](https://www.npmjs.com/package/mcp-google-multi)

- 🧰 **Exhaustive** — 872 tools across 28 services + an escape hatch for anything else → [COVERAGE.md](./COVERAGE.md)
- 🔑 **Multi-account** — drive any number of Google accounts by alias, or fan one call out across all of them
- 🔒 **Private by design** — your own OAuth app, tokens encrypted at rest (AES-256-GCM), writes deny-by-default, no telemetry, no metering — it talks only to Google

## Quick setup

You don't need to know anything about MCP or OAuth — five steps, all copy-paste:

1. **Install [Node.js](https://nodejs.org) 20 or newer**, then install the server:

   ```bash
   npm install -g mcp-google-multi
   ```

2. **Create your (free) Google app** so the server can sign in as you — one-time, ~2 minutes: follow [Google Cloud setup](./docs/google-cloud-setup.md). You come back with a **Client ID** and **Client Secret**.

3. **Create a file named `.env`** in the folder you'll run from, and fill in your values:

   ```bash
   GOOGLE_CLIENT_ID=paste-your-client-id
   GOOGLE_CLIENT_SECRET=paste-your-client-secret
   # name each Google account with a short alias:
   GOOGLE_ACCOUNTS=work:you@company.com,personal:you@gmail.com
   # encryption key for stored tokens — generate one with: openssl rand -base64 32
   MASTER_KEY=paste-the-generated-key
   ```

4. **Sign in each account** (a browser window opens; approve the permissions):

   ```bash
   mcp-google-multi auth --account work
   mcp-google-multi auth --account personal
   ```

5. **Connect it to Claude Code** (any MCP client works the same way):

   ```bash
   claude mcp add google-multi -s user -- npx -y mcp-google-multi
   ```

Restart your client and the tools appear. Check everything with `mcp-google-multi config check`.

**Go deeper:** [Configuration reference](./docs/configuration.md) · [What's covered](./COVERAGE.md) · [Features tour](./docs/features.md) · [Secrets in a vault](./docs/secrets.md) · [Upgrading from v4](./docs/upgrading-v4.md) · [Security policy](./SECURITY.md) · [Roadmap](https://github.com/bakissation/mcp-google-multi/milestones)

## Maintainer & credits

Built and maintained by **Abdelbaki Berkati** — [berkati.xyz](https://berkati.xyz) · [@bakissation](https://github.com/bakissation). [Read the case study →](https://berkati.xyz/case-studies/mcp-google-multi/)

Development is **funded by [IdeaCrafters](https://ideacrafters.com)** ([@IdeaCraftersHQ](https://github.com/IdeaCraftersHQ)) — the studio that pays for this OSS to exist.

Thanks to contributors [@obatried](https://github.com/obatried), [@trevor-commits](https://github.com/trevor-commits), and [@mjreddy](https://github.com/mjreddy). The project is maintainer-led (roadmap on [Milestones](https://github.com/bakissation/mcp-google-multi/milestones); bug reports welcome, feature PRs by prior agreement — see [CONTRIBUTING.md](./CONTRIBUTING.md)). **v5 is complete and in a feedback period: [open an issue](https://github.com/bakissation/mcp-google-multi/issues/new/choose) with bugs, pain points, or what you wish it did — it directly shapes the v6 roadmap.** Security reports go to [SECURITY.md](./SECURITY.md), never a public issue.

## License

[MIT](./LICENSE)
