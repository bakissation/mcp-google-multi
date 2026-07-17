# Upgrading from v4

v5 is a breaking change, but the migration is a one-time, ~2-minute step. Back to the [README](../README.md).

1. Update: `npm i -g mcp-google-multi@latest` (or update your client config).
2. Add **`MASTER_KEY`** to your environment (`openssl rand -base64 32`) — now required.
3. Encrypt existing tokens: `mcp-google-multi migrate-tokens` (reads your old `tokens/<alias>/token.json` and encrypts them) — or just re-auth each account.
4. Writes are now **deny-by-default** — set `GOOGLE_PROFILE=safe-writes` (or `full-writes`) to keep writing. (`GOOGLE_ALLOW_ADMIN_WRITES` is gone — replaced by [write-control profiles](./configuration.md#write-control-deny-by-default).)

v5 is **local + user-OAuth only**. Service accounts and hosting (and the APIs they unlock) are tracked for v6 on the [roadmap](https://github.com/bakissation/mcp-google-multi/milestones).
