# Keep secrets in a vault

A plaintext `.env` is fine to try things out, but for a daily driver, **don't leave `GOOGLE_CLIENT_SECRET` + `MASTER_KEY` on disk** — inject them at launch from a secrets manager. The server just reads `process.env` (it has no idea where the values come from), so wrap it. Back to the [README](../README.md).

Example with [Infisical](https://infisical.com):

```bash
#!/usr/bin/env bash
# ~/.local/bin/mcp-google-multi-run  — chmod +x, then register this as the MCP command
set -euo pipefail
export INFISICAL_TOKEN="$(infisical login --method=universal-auth \
  --client-id "$YOUR_CLIENT_ID" --client-secret "$YOUR_CLIENT_SECRET" --plain --silent)"
exec infisical run --projectId <project> --env prod --path /mcp-google-multi \
  -- npx -y mcp-google-multi
```

```bash
claude mcp add google-multi -s user -- ~/.local/bin/mcp-google-multi-run
```

Now the only thing on disk is the **encrypted** token store. Pass the token via the `INFISICAL_TOKEN` env var (as above), **not** a `--token` flag, so it never shows up in `ps`. Any secrets manager works — Doppler, Vault, 1Password CLI, etc. — the pattern is the same.
