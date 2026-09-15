# Remote HTTP setup (tunnels + one-click deploys)

By default the server runs **locally over stdio** — your MCP client launches it as a subprocess and there is no network surface. You only need this guide if you want to reach the server **remotely over HTTP**: from [claude.ai](https://claude.ai) as a custom connector, from a phone, or from a machine that isn't the one running the server. Back to the [README](../README.md).

Remote HTTP changes the security model. Locally, the process **is** the owner. Remotely, anyone who can reach the URL can try to authenticate, so the server ships a small OAuth 2.1 authorization server and **refuses to start HTTP** until you name the Google account(s) allowed in — the *owner gate*. Two rules are non-negotiable for every recipe below:

- **`MCP_OWNER_EMAILS`** must list the Google email(s) allowed to sign in. Empty ⇒ startup fails with `E_OWNER_EMAILS_REQUIRED`. This is the entire multi-tenant defense; there is no default.
- **`MCP_PUBLIC_URL`** must be the externally reachable **HTTPS** origin (e.g. `https://mcp.example.com`). The server keeps binding to `127.0.0.1`, but every OAuth metadata document, redirect, and JWT `aud` is derived from this URL. Get it wrong and every `/mcp` call 401-loops (the #1 interop bug).

Pick your path:

| You have… | Use | Section |
|---|---|---|
| Your own always-on box | a Cloudflare **named** tunnel in front of the local server | [Named tunnel](#option-a-cloudflare-named-tunnel) |
| A box, and you prefer containers | the [Docker image](../Dockerfile) + a named tunnel | [Docker + tunnel](#option-b-docker--tunnel) |
| No box | a one-click **deploy button** (Render / Railway) | [Deploy buttons](#option-c-one-click-deploy-render--railway) |

Everything you paste is generic: replace `mcp.example.com` with your host and `<owner@example.com>` with your Google email.

---

## Prerequisites (all options)

1. A Google OAuth client and its **Client ID / Secret** — see [Google Cloud setup](./google-cloud-setup.md). One extra step for remote use is called out under [the redirect URI](#the-google-console-redirect-uri) below.
2. A `MASTER_KEY` (base64 32-byte) that encrypts stored tokens at rest. Generate once with `openssl rand -base64 32` and keep it stable — a changed key bricks existing tokens. On a PaaS the platform can mint and persist it for you (see below).
3. Your accounts, as usual: `GOOGLE_ACCOUNTS=work:you@company.com,personal:you@gmail.com` (or a `config.json`; see [configuration](./configuration.md)).

Full key reference: [docs/configuration.md](./configuration.md). Keeping secrets out of plaintext files: [docs/secrets.md](./secrets.md).

---

## Option A: Cloudflare named tunnel

> **Quick tunnels (`cloudflared tunnel --url …`) are demo-only.** They cap at ~200 concurrent connections and do not reliably carry SSE, so a real connector must use a **named** tunnel. The one-off `trycloudflare.com` URL is fine for a five-minute smoke test and nothing else.

You need [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) installed and a domain on Cloudflare.

```sh
cloudflared tunnel login
cloudflared tunnel create mcp-google-multi
```

Write `~/.cloudflared/config.yml`, pointing the tunnel at the loopback port the server listens on:

```yaml
tunnel: <UUID-from-create>
credentials-file: /home/<user>/.cloudflared/<UUID>.json
ingress:
  - hostname: mcp.example.com
    service: http://127.0.0.1:4243
  - service: http_status:404
```

Route DNS and install the tunnel as a service:

```sh
cloudflared tunnel route dns mcp-google-multi mcp.example.com
cloudflared service install
```

Now start the server so it *advertises* the public host while still binding loopback:

```sh
MCP_TRANSPORT=http \
MCP_HTTP_HOST=127.0.0.1 \
MCP_HTTP_PORT=4243 \
MCP_PUBLIC_URL=https://mcp.example.com \
MCP_OWNER_EMAILS=<owner@example.com> \
  npx -y mcp-google-multi
```

Confirm it's alive: `curl https://mcp.example.com/health` returns `{"status":"ok","transport":"http",…}` (no secrets).

### Load-bearing wiring

Each of these has a concrete failure mode if you skip it:

| Setting | Value | Failure if wrong |
|---|---|---|
| `MCP_PUBLIC_URL` | `https://mcp.example.com` | Metadata advertises `http://127.0.0.1:4243`; `resource`/`aud` mismatch; **every `/mcp` call 401-loops**. |
| `MCP_OWNER_EMAILS` | your Google email(s), comma-separated | Empty ⇒ `E_OWNER_EMAILS_REQUIRED` at startup. A wrong address ⇒ the owner sign-in is rejected. |
| Google Console redirect URI | add `https://mcp.example.com/callback` | Google returns `redirect_uri_mismatch` on both the owner sign-in and per-alias re-auth. |
| Origin allowlist | `https://claude.ai` is allowed automatically; add others via `MCP_ALLOWED_ORIGINS` | A present-but-unlisted browser `Origin` gets **403** on `/mcp` and every OAuth endpoint. |
| Claude connector URL | paste `https://mcp.example.com/mcp` | Wrong path ⇒ the client can't discover the authorization server. |

### The Google Console redirect URI

For remote HTTP, Google must be told to send the sign-in callback to your public host. In the [Google Cloud Console](https://console.cloud.google.com) → **Credentials** → your OAuth client → **Authorized redirect URIs**, add:

```
https://mcp.example.com/callback
```

(The local stdio flow uses `http://localhost:4242/oauth2callback`; the remote flow uses `/callback` on your public host. You can keep both.)

Then [connect Claude](#connecting-claude).

---

## Option B: Docker + tunnel

The repo ships a distroless, non-root [`Dockerfile`](../Dockerfile) (Node 22, no shell). Build and run it, passing secrets **only at runtime** — never bake them into a layer:

```sh
docker build -t mcp-google-multi .
docker run --init --rm -p 127.0.0.1:4243:4243 --env-file secrets.env mcp-google-multi
```

- `--init` matters: distroless has no init to reap PID 1, so `--init` lets Docker forward `SIGTERM` for a clean shutdown.
- Keep the published port on `127.0.0.1` and reach it from `cloudflared`. The cleanest wiring is a compose file where `cloudflared` shares the container's network namespace so the bind never leaves loopback:

```yaml
services:
  mcp:
    build: .
    env_file: secrets.env      # GOOGLE_CLIENT_ID/SECRET, MASTER_KEY, MCP_OWNER_EMAILS, MCP_PUBLIC_URL
    init: true
    volumes:
      - mcp-config:/home/nonroot/.config/mcp-google-multi   # persist tokens + master.key
  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel run
    network_mode: "service:mcp"   # cloudflared reaches the server on 127.0.0.1:4243
    volumes:
      - ~/.cloudflared:/home/nonroot/.cloudflared:ro
volumes:
  mcp-config:
```

> **Persist the config volume.** Distroless has no OS keychain, so `MASTER_KEY` provisioning falls back to a `0600` file under the config dir. If that volume is ephemeral, `MASTER_KEY` regenerates on restart and **bricks every stored token**. Either mount a durable volume (above) or pass a fixed `MASTER_KEY` in `secrets.env`.

`secrets.env` never enters the image — it's already covered by [`.dockerignore`](../.dockerignore) alongside `*.enc` and `master.key`. Same tunnel wiring and Google redirect URI as [Option A](#option-a-cloudflare-named-tunnel).

---

## Option C: One-click deploy (Render + Railway)

No box required. Both platforms build the repo's [`Dockerfile`](../Dockerfile) and give you a public HTTPS URL. You still provide your own Google client and owner email — the templates prompt for them and commit nothing secret.

### Render

The repo ships [`render.yaml`](../render.yaml) as a Render Blueprint. From the Render dashboard, **New → Blueprint**, point it at your fork, and fill in the prompted values:

| Variable | You provide | Notes |
|---|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | your OAuth client | `sync: false` — prompted, never stored in the repo |
| `MCP_OWNER_EMAILS` | your Google email(s) | `sync: false`; empty ⇒ the service fails to start (by design) |
| `MCP_PUBLIC_URL` | the service's public URL | e.g. `https://mcp-google-multi.onrender.com`; paste it after the first deploy assigns it |
| `GOOGLE_ACCOUNTS` | `work:…,personal:…` | your alias list |
| `MASTER_KEY` | *(nothing)* | `generateValue: true` — Render mints it once and **persists** it across redeploys |

`autoDeploy` is `false`: the service never redeploys on an upstream push unless you ask. After the first deploy, copy the assigned URL into `MCP_PUBLIC_URL`, redeploy once, then add `<that-url>/callback` to your [Google Console redirect URIs](#the-google-console-redirect-uri).

### Railway

The repo ships [`railway.toml`](../railway.toml) pinning the Dockerfile build. Create a service from your fork, then set the same variables in the Railway dashboard (**Variables**):

- `MCP_TRANSPORT=http`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MCP_OWNER_EMAILS`, `GOOGLE_ACCOUNTS` — your values
- `MCP_PUBLIC_URL` — set to the Railway-provided public domain (**Settings → Networking → Generate Domain**)
- `MASTER_KEY` — generate once (`openssl rand -base64 32`) and paste it; Railway persists variables, so it stays stable

Then, as with Render, add `<your-railway-domain>/callback` to the Google Console redirect URIs and [connect Claude](#connecting-claude).

> **Fly is intentionally not covered.** Render + Railway are the supported one-click paths.

---

## Connecting Claude

Once the server answers on `https://mcp.example.com/health`:

1. In [claude.ai](https://claude.ai) → **Settings → Connectors → Add custom connector**, paste the **MCP endpoint**: `https://mcp.example.com/mcp`.
2. Claude discovers the authorization server (protected-resource metadata → AS metadata → `/authorize`) and opens a sign-in window.
3. Sign in with an account listed in `MCP_OWNER_EMAILS`. That gates access; it does **not** by itself grant any Gmail/Drive scope.
4. Each Google alias is authorized separately the first time a tool touches it (per-alias re-auth), so a connector can drive several accounts without re-running the owner gate.

For **Claude Code** over HTTP: `claude mcp add --transport http gmulti https://mcp.example.com/mcp`.

---

## Security & trust boundaries

Putting the server on the internet has real consequences — read these before you leave it running.

| Concern | What to know |
|---|---|
| **Cloudflare (or the PaaS) sees plaintext** | The tunnel/platform **terminates TLS**, so it can see the bearer token and every Gmail/Drive byte in transit. This is a trust boundary, not a bug: you are trusting your tunnel provider the same way you trust your DNS. If that's unacceptable, don't expose the server. |
| **The owner gate is the whole defense** | `MCP_OWNER_EMAILS` decides who may authenticate at all. Keep it to the accounts you actually own. An empty or over-broad list collapses the multi-tenant boundary. |
| **Public endpoints invite abuse** | `/authorize` and `/token` are reachable by anyone. The server caps its replay-guard and CIMD fetches, but a public deployment should sit behind **Cloudflare WAF / rate-limiting** (e.g. a rate rule on `/authorize` and `/token`). Configure this in your Cloudflare dashboard. |
| **Never bake secrets into artifacts** | Secrets go in at runtime only — `--env-file`, the platform's secret store, or the OS keychain. `.dockerignore` keeps `.env`/`*.enc`/`master.key` out of image layers; the deploy templates mark every secret `sync: false`. |
| **`MASTER_KEY` must persist** | Any platform that auto-generates it must persist it across redeploys (Render's `generateValue` does). A regenerated key when tokens exist is a hard-guarded brick, so the server refuses to start rather than silently lose your tokens. |

The full security model lives in the codebase's `cc-security` design; this page only covers what's specific to exposing an HTTP endpoint.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Every `/mcp` call returns **401** in a loop | `MCP_PUBLIC_URL` doesn't match the URL the client reached (often `http://localhost` leaked into the metadata) | Set `MCP_PUBLIC_URL` to the exact external HTTPS origin and restart. Verify with `curl https://mcp.example.com/.well-known/oauth-protected-resource`. |
| **403** on `/mcp` or an OAuth endpoint | the browser `Origin` isn't allowlisted, or the `Host` header isn't recognized | `https://claude.ai` is allowed by default; add other origins via `MCP_ALLOWED_ORIGINS`. Make sure the tunnel forwards the real `Host`. |
| Google shows **`redirect_uri_mismatch`** | the public `/callback` URI isn't registered | Add `https://<your-host>/callback` under the OAuth client's Authorized redirect URIs. |
| Server **won't start**, prints `E_OWNER_EMAILS_REQUIRED` | `MCP_TRANSPORT` includes `http` but `MCP_OWNER_EMAILS` is empty | Set `MCP_OWNER_EMAILS` to the Google email(s) allowed to sign in. |
| Connector connects but a tool returns `insufficient_scope` | that alias hasn't granted the needed scope yet | Trigger the per-alias re-auth (the hint is in the error) or add the relevant [scope bundle](./configuration.md#optional-scope-bundles). |
| `curl /health` works but the connector can't reach it | you used a **quick** tunnel | Switch to a **named** tunnel (Option A). |
