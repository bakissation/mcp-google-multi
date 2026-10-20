# Remote HTTP setup (tunnels + one-click deploys)

By default the server runs **locally over stdio** — your MCP client launches it as a subprocess and there is no network surface. You only need this guide if you want to reach the server **remotely over HTTP**: from [claude.ai](https://claude.ai) as a custom connector, from a phone, or from a machine that isn't the one running the server. Back to the [README](../README.md).

Remote HTTP changes the security model. Locally, the process **is** the owner. Remotely, anyone who can reach the URL can try to authenticate, so the server ships a small OAuth 2.1 authorization server and **refuses to start HTTP** until you name the Google account(s) allowed in — the *owner gate*. Two rules are non-negotiable for every recipe below:

- **`MCP_OWNER_EMAILS`** must list the Google email(s) allowed to sign in. Empty ⇒ startup fails with `E_OWNER_EMAILS_REQUIRED`. This is the entire multi-tenant defense; there is no default.
- **`MCP_PUBLIC_URL`** must be the externally reachable **HTTPS** origin (e.g. `https://mcp.example.com`) for anything reachable beyond this machine. `http://127.0.0.1:<port>` is accepted for local use only; the server does not refuse `http://` on other hosts, so over plain HTTP the sign-in and tokens travel unencrypted. The server keeps binding to `127.0.0.1`, but every OAuth metadata document, redirect, and JWT `aud` is derived from this URL. Get it wrong and every `/mcp` call 401-loops (the #1 interop bug).

Pick your path:

| You have… | Use | Section |
|---|---|---|
| A box + a domain, want it up in 3 commands | the **published image** + Docker Compose, optional automatic HTTPS via Caddy | [Pull and up](#option-0-pull-and-up-docker-compose) |
| Your own always-on box | a Cloudflare **named** tunnel in front of the local server | [Named tunnel](#option-a-cloudflare-named-tunnel) |
| A box, and you prefer containers | the [Docker image](../Dockerfile) + a named tunnel | [Docker + tunnel](#option-b-docker--tunnel) |
| No box | a one-click **deploy button** (Render / Railway) | [Deploy buttons](#option-c-one-click-deploy-render--railway) |

Everything you paste is generic: replace `mcp.example.com` with your host and `<owner@example.com>` with your Google email.

---

## Prerequisites (all options)

1. A Google OAuth client of type **Web application** and its **Client ID / Secret** — see [Google Cloud setup](./google-cloud-setup.md). Only a Web application client can register the public redirect URI described under [the redirect URI](#the-google-console-redirect-uri) below.
2. Optionally, a `MASTER_KEY` (base64 32-byte) that encrypts stored tokens at rest. Unset, the server generates one into a `0600` `master.key` file in its config directory on first start, so that directory must persist. To set it yourself, generate once with `openssl rand -base64 32` and keep it stable — a changed key bricks existing tokens. On a PaaS the platform can mint and persist it for you (see below).
3. Your accounts, as usual: `GOOGLE_ACCOUNTS=work:you@company.com,personal:you@gmail.com` (or a `config.json`; see [configuration](./configuration.md)).

A headless box (Docker, Render, Railway) has no browser, and both the owner sign-in and each account's Google consent need one. Mint tokens on a workstation first (`mcp-google-multi auth --account <alias>` for each account), then bundle them with `mcp-google-multi account export --out bundle.enc` and ship that bundle to the target as a secret, same as `MASTER_KEY` or the client secret. Run `mcp-google-multi account import bundle.enc` there before the server ever serves HTTP. See [account export / import](./features.md) for what the bundle does and doesn't carry.

Full key reference: [docs/configuration.md](./configuration.md). Keeping secrets out of plaintext files: [docs/secrets.md](./secrets.md).

---

## Option 0: pull and up (Docker Compose)

No build step: every release publishes a multi-arch image to `ghcr.io/bakissation/mcp-google-multi` (a ~6 MB single-file bundle on distroless Node — attested provenance + SBOM). The [`deploy/`](../deploy) folder holds everything you need:

```sh
curl -fsSLO https://raw.githubusercontent.com/bakissation/mcp-google-multi/main/deploy/{compose.yaml,Caddyfile,.env.example}
cp .env.example .env   # fill it in (client ID/secret, accounts, owner emails, public URL)
docker compose up -d
```

Set `MCP_HTTP_HOST=0.0.0.0` in `.env`: the server binds container loopback by default, which neither the published host port nor Caddy can reach. The host side is published on `127.0.0.1:4243` only — front it with your own proxy or a [named tunnel](#option-a-cloudflare-named-tunnel). **Have a domain instead?** Point an A record at the box, open ports 80+443, uncomment `MCP_DOMAIN` in `.env`, set `MCP_PUBLIC_URL=https://<your domain>`, then:

```sh
COMPOSE_PROFILES=caddy docker compose up -d
```

Caddy obtains and renews the certificate automatically; nothing else to configure.

- **Image tags**: the compose file tracks the stable major (`:6`). Set `MCP_IMAGE_TAG` in `.env` to pin an exact version (`:6.0.0`) or to follow a prerelease channel (`beta`, `dev`).
- **Upgrade**: `docker compose pull && docker compose up -d`.
- **State**: tokens + the auto-provisioned `MASTER_KEY` file live in the `mcp-config` volume — keep it. Recreating the volume invalidates every stored token.
- **Host files**: `drive_upload`/`drive_update`/`drive_download`/`drive_export`/`gmail_download_attachment` and Gmail attachments are confined to `GOOGLE_LOCAL_FILES_DIR` (`/data/files` in the image), the separate `mcp-files` volume. Uploading from, or saving to, anywhere else is refused; move the file into the volume first, or set `GOOGLE_LOCAL_FILES=off` to remove these tools entirely. The named `mcp-files` volume above already has the right ownership (it is seeded from the image). If a bind mount is used instead (`-v /host/path:/data/files`), that host directory must be owned by uid `65532` (the image's nonroot user), or the container cannot create files under it: `sudo chown 65532:65532 /host/path` before first use.
- The Google **redirect URI** and Claude connection steps below apply to this option too.

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

HTTP transport needs 6.0.0 or later, which npm `latest` serves (5.x is stdio-only).

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

For remote HTTP, Google must be told to send the sign-in callback to your public host. In the [Google Cloud Console](https://console.cloud.google.com) → **Credentials** → your **Web application** OAuth client → **Authorized redirect URIs**, add:

```
https://mcp.example.com/callback
```

(The local stdio flow uses an ephemeral `http://localhost:<port>/oauth2callback` loopback redirect, which only a Desktop app client accepts on any port; the remote flow uses `/callback` on your public host, which only a Web application client can register. A deployment uses the one client named by `GOOGLE_CLIENT_ID`.)

Then [connect Claude](#connecting-claude).

---

## Option B: Docker + tunnel

The repo ships a distroless, non-root [`Dockerfile`](../Dockerfile) (Node 22, no shell). Build and run it, passing secrets **only at runtime** — never bake them into a layer:

```sh
docker build -t mcp-google-multi .
docker run --init --rm -p 127.0.0.1:4243:4243 -e MCP_HTTP_HOST=0.0.0.0 --env-file secrets.env mcp-google-multi
```

- `--init` matters: distroless has no init to reap PID 1, so `--init` lets Docker forward `SIGTERM` for a clean shutdown.
- With `-p`, `MCP_HTTP_HOST=0.0.0.0` is required: the image binds container loopback by default, which a published port cannot reach. Keep the published port on `127.0.0.1` and reach it from `cloudflared`. The cleanest wiring is a compose file where `cloudflared` shares the container's network namespace, so the default loopback bind works and never leaves the container:

```yaml
services:
  mcp:
    build: .
    env_file: secrets.env      # GOOGLE_CLIENT_ID/SECRET, MASTER_KEY, MCP_OWNER_EMAILS, MCP_PUBLIC_URL
    init: true
    volumes:
      - mcp-config:/home/nonroot/.config/mcp-google-multi   # persist tokens + master.key
      - mcp-files:/data/files                               # GOOGLE_LOCAL_FILES_DIR: uploads/downloads/attachments
  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel run
    network_mode: "service:mcp"   # cloudflared reaches the server on 127.0.0.1:4243
    volumes:
      - ~/.cloudflared:/home/nonroot/.cloudflared:ro
volumes:
  mcp-config:
  mcp-files:
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
| `MCP_HTTP_HOST` | `0.0.0.0` | not in the Blueprint: add it under **Environment**. The image binds container loopback by default, which Render's proxy cannot reach; the server listens on `4243` |

`autoDeploy` is `false`: the service never redeploys on an upstream push unless you ask. After the first deploy, copy the assigned URL into `MCP_PUBLIC_URL`, redeploy once, then add `<that-url>/callback` to your [Google Console redirect URIs](#the-google-console-redirect-uri).

### Railway

The repo ships [`railway.toml`](../railway.toml) pinning the Dockerfile build. Create a service from your fork, then set the same variables in the Railway dashboard (**Variables**):

- `MCP_TRANSPORT=http`
- `MCP_HTTP_HOST=0.0.0.0` — the image binds container loopback by default, which Railway's proxy cannot reach
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MCP_OWNER_EMAILS`, `GOOGLE_ACCOUNTS` — your values
- `MCP_PUBLIC_URL` — set to the Railway-provided public domain (**Settings → Networking → Generate Domain**, target port `4243`)
- `MASTER_KEY` — generate once (`openssl rand -base64 32`) and paste it; Railway persists variables, so it stays stable

Then, as with Render, add `<your-railway-domain>/callback` to the Google Console redirect URIs and [connect Claude](#connecting-claude).

> **Fly is intentionally not covered.** Render + Railway are the supported one-click paths.

---

## Connecting Claude

Once the server answers on `https://mcp.example.com/health`:

1. In [claude.ai](https://claude.ai) → **Settings → Connectors → Add custom connector**, paste the **MCP endpoint**: `https://mcp.example.com/mcp`.
2. Claude discovers the authorization server (protected-resource metadata → AS metadata → `/authorize`) and opens a sign-in window.
3. Sign in with an account listed in `MCP_OWNER_EMAILS`. That gates access; it does **not** by itself grant any Gmail/Drive scope.
4. Each Google alias is authorized separately (per-alias re-auth): a tool call on an alias without a usable Google token returns an error whose hint is a re-auth link, so a connector can drive several accounts without re-running the owner gate. The link is signed by the server and valid for an hour; an expired or hand-built link is refused, so ask the tool again for a fresh one.

For **Claude Code** over HTTP: `claude mcp add --transport http gmulti https://mcp.example.com/mcp`.

---

## Security & trust boundaries

Putting the server on the internet has real consequences — read these before you leave it running.

| Concern | What to know |
|---|---|
| **Cloudflare (or the PaaS) sees plaintext** | The tunnel/platform **terminates TLS**, so it can see the bearer token and every Gmail/Drive byte in transit. This is a trust boundary, not a bug: you are trusting your tunnel provider the same way you trust your DNS. If that's unacceptable, don't expose the server. |
| **The owner gate is the whole defense** | `MCP_OWNER_EMAILS` decides who may authenticate at all. Keep it to the accounts you actually own. An empty or over-broad list collapses the multi-tenant boundary. |
| **Public endpoints invite abuse** | `/authorize`, `/callback` and `/token` are reachable by anyone. The server bounds its replay guard and CIMD fetches and fails closed: 100,000 requests to `/authorize` in any 10-minute window fill its 100,000-slot guard (about 170 a second keep it full) and block every new sign-in with 503 `E_SIGNIN_BUSY`, for up to 10 minutes after a burst, rather than letting a spent sign-in step through. A public deployment should sit behind a per-IP rate limit, e.g. **Cloudflare WAF / rate-limiting** rules on `/authorize`, `/callback` and `/token`. Configure this in your Cloudflare dashboard. |
| **Never bake secrets into artifacts** | Secrets go in at runtime only — `--env-file`, the platform's secret store, or the OS keychain. `.dockerignore` keeps `.env`/`*.enc`/`master.key` out of image layers; `render.yaml` marks every secret `sync: false` (or `generateValue` for `MASTER_KEY`), and `railway.toml` holds none. |
| **`MASTER_KEY` must persist** | Any platform that auto-generates it must persist it across redeploys (Render's `generateValue` does). A regenerated key when tokens exist is a hard-guarded brick, so the server refuses to start rather than silently lose your tokens. |

This page only covers what's specific to exposing an HTTP endpoint; reporting and scope are in [SECURITY.md](../SECURITY.md).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Every `/mcp` call returns **401** in a loop | `MCP_PUBLIC_URL` doesn't match the URL the client reached (often `http://localhost` leaked into the metadata) | Set `MCP_PUBLIC_URL` to the exact external HTTPS origin and restart. Verify with `curl https://mcp.example.com/.well-known/oauth-protected-resource`. |
| **403** on `/mcp` or an OAuth endpoint | the browser `Origin` isn't allowlisted (`origin_rejected`), or the `Host` header isn't recognized (`host_rejected`) | `https://claude.ai` is allowed by default; add other origins via `MCP_ALLOWED_ORIGINS`. Make sure the tunnel forwards the real `Host`, matching `MCP_PUBLIC_URL`. |
| Google shows **`redirect_uri_mismatch`** | the public `/callback` URI isn't registered | Add `https://<your-host>/callback` under the OAuth client's Authorized redirect URIs. |
| Server **won't start**, prints `E_OWNER_EMAILS_REQUIRED` | `MCP_TRANSPORT` includes `http` but `MCP_OWNER_EMAILS` is empty | Set `MCP_OWNER_EMAILS` to the Google email(s) allowed to sign in. |
| Connector connects but a tool returns `insufficient_scope` | that alias hasn't granted the needed scope yet | Trigger the per-alias re-auth (the hint is in the error) or add the relevant [scope bundle](./configuration.md#optional-scope-bundles). |
| `curl /health` works but the connector can't reach it | you used a **quick** tunnel | Switch to a **named** tunnel (Option A). |
