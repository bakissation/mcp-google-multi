# mcp-google-multi

The most complete **local Google Workspace MCP server**: Gmail, Drive, Calendar, Sheets, Docs, Slides, Forms, Contacts, Tasks, Chat, Meet, Analytics (GA4), Search Console, Classroom, Vault, Admin and more — **every OAuth-reachable API method** as a tool, across **multiple Google accounts** at once, from Claude Code or any MCP client.

[![npm](https://img.shields.io/npm/v/mcp-google-multi?label=npm&color=cb3837)](https://www.npmjs.com/package/mcp-google-multi)

- 🧰 **Exhaustive** — 970 tools across 29 services, now including Google Analytics (GA4), + an escape hatch for anything else → [COVERAGE.md](./COVERAGE.md)
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

   Claude Desktop user? You can skip npm entirely: download the `mcp-google-multi.mcpb` bundle from the [latest release](https://github.com/bakissation/mcp-google-multi/releases/latest), double-click it (or drag it into Claude Desktop → Settings → Extensions), and fill in the values from step 2 when prompted.

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
   claude mcp add mcp-google-multi -s user -- npx -y mcp-google-multi
   ```

**Stuck at any point? Run `mcp-google-multi doctor`.** It inspects every part and prints the exact fix for anything wrong (a missing sign-in, a Google API you still need to switch on, and so on). Once it reads all-green, just talk to Claude: *"summarize my unread email."*

*Got more than one Google account?* Add them together, like `GOOGLE_ACCOUNTS=me:you@gmail.com,work:you@company.com`, and run step 4 once per nickname.

*On a server or from claude.ai?* Advanced path: [Remote / HTTP setup](./docs/http-setup.md). *Coming from v5?* [v6 migration guide](./MIGRATION-v6.md).

**Go deeper:** [Configuration reference](./docs/configuration.md) · [What's covered](./COVERAGE.md) · [Features tour](./docs/features.md) · [Remote / HTTP setup](./docs/http-setup.md) · [Secrets in a vault](./docs/secrets.md) · [Local usage metrics](./docs/usage-metrics.md) · [Migrating to v6](./MIGRATION-v6.md) · [Security policy](./SECURITY.md) · [Roadmap](https://github.com/bakissation/mcp-google-multi/milestones)

## Which one to use: this server or Google's hosted Workspace MCP servers

Google now runs its own remote MCP servers for Workspace. This is how they compare, from Google's pages as read on 17 November 2026. Their status can change, so check the sources before you decide.

| | Google's hosted servers | mcp-google-multi |
|---|---|---|
| Where it runs | Google's endpoints, one per product (`gmailmcp`, `drivemcp`, `docsmcp`, `sheetsmcp`, `slidesmcp`, `calendarmcp`, `chatmcp`, People, Classroom, and a `search_corpus` search server) | Your machine over stdio, or your own host over HTTP |
| Status | Developer Preview, and you need membership in the Google Workspace Developer Preview Program. No GA date is stated | Released and versioned, MIT licensed |
| Setup | Enable the MCP services in a Google Cloud project, make a Web application OAuth client with "Use this client for an AI-powered agent" ticked, add test users if the consent screen is External | Your own OAuth client, an interactive setup wizard and a `doctor` check |
| Scopes | Narrow, for example `gmail.readonly` and `gmail.compose` for Gmail, `drive.file` and `drive.readonly` for Drive | Per-account scope profiles, from read-only up to the full set you grant |
| Coverage | Gmail, Drive, Docs, Sheets, Slides, Calendar, Chat, People, Classroom | 970 tools across 29 services, plus an escape hatch for any REST method ([COVERAGE.md](./COVERAGE.md)) |
| Accounts | User-delegated OAuth, or service accounts with domain-wide delegation | Several Google accounts at once, by alias |
| Writes | Sensitive actions through domain-wide delegation get confirmation prompts | Denied by default, with write profiles, an outbound recipient allowlist and local file confinement |
| Limits and pricing | Not stated on the pages read | No metering or telemetry. Google's own API quotas apply to your client |
| Admin view | Developer access is managed in the Admin console under Security > API Controls | You run it, so you own the credentials and the logs |

**Pick Google's servers** when you want a first-party, no-install connector for Gmail, Drive, Calendar, Docs, Sheets or Slides, you are comfortable with a preview product, and the narrower scopes suit the job. They are also the natural choice when your organisation wants Google to host the connection.

**Pick this server** when you need more than those products (Tasks, Forms, Meet, Analytics, Search Console, Admin and the rest), more than one account in one session, local files and attachments, a stricter write policy, or something that is not in preview.

Nothing stops you running both: they are separate MCP servers.

Sources: [Configure the Google Workspace MCP servers](https://developers.google.com/workspace/guides/configure-mcp-servers), [Universal Search MCP server](https://developers.google.com/workspace/guides/universal-search-mcp), [Workspace Updates, 1 May 2026](https://workspaceupdates.googleblog.com/2026/05/agent-tools-and-security-updates-for-workspace-developers.html).

## Agent skill

The repo and the npm package both ship an [Agent Skill](https://code.claude.com/docs/en/skills) at `skills/google-workspace/`: a hand-written `SKILL.md` covering account selection, the discover step, incremental Gmail sweeps, keeping results small, write profiles, and the escape hatch, plus a `reference/` folder with a generated argument table per service. Loading it gets an agent calling this server's tools correctly without guessing argument names.

To install it for Claude Code, copy or symlink the `skills/google-workspace` folder into `~/.claude/skills/` (every project) or a project's own `.claude/skills/` (that project only):

```bash
# from a cloned copy of this repo
ln -s "$(pwd)/skills/google-workspace" ~/.claude/skills/google-workspace

# from the installed npm package
ln -s "$(npm root -g)/mcp-google-multi/skills/google-workspace" ~/.claude/skills/google-workspace
```

## Maintainer, sponsor & license

Built and maintained by **Abdelbaki Berkati** — [berkati.xyz](https://berkati.xyz) · [@bakissation](https://github.com/bakissation). [Read the case study →](https://berkati.xyz/case-studies/mcp-google-multi/)

Development is **funded by [IdeaCrafters](https://ideacrafters.com)** ([@IdeaCraftersHQ](https://github.com/IdeaCraftersHQ)) — the studio that pays for this OSS to exist.

An Enterprise Edition (hosted, multi-tenant) is available: ask through [berkati.xyz](https://berkati.xyz) (email or LinkedIn there).

Thanks to contributors [@obatried](https://github.com/obatried), [@trevor-commits](https://github.com/trevor-commits), and [@mjreddy](https://github.com/mjreddy). The project is maintainer-led (roadmap on [Milestones](https://github.com/bakissation/mcp-google-multi/milestones); bug reports welcome, feature PRs by prior agreement — see [CONTRIBUTING.md](./CONTRIBUTING.md)). **Feedback shapes the roadmap: [open an issue](https://github.com/bakissation/mcp-google-multi/issues/new/choose) with bugs, pain points, or what you wish it did.** Security reports go to [SECURITY.md](./SECURITY.md), never a public issue.

Licensed under [MIT](./LICENSE).
