# syntax=docker/dockerfile:1
# B16: distroless Node 22, non-root. Multi-stage: build dist/ with full deps,
# prune to runtime deps, copy into a distroless runtime that has no shell and
# runs as `nonroot`. No secrets are ever baked in — pass them at `docker run`
# via --env-file / orchestrator secrets (see docs/configuration.md, B17 tunnel
# guide). Run with `docker run --init` so SIGTERM reaches node for a clean
# shutdown (distroless has no init to reap PID 1).

# --- build stage -----------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm ci --omit=dev

# --- runtime stage ---------------------------------------------------------
FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
ENV NODE_ENV=production
# HTTP transport by default. The bind stays loopback (MCP_HTTP_HOST=127.0.0.1)
# and the server refuses any exposed HTTP shape until the OAuth authorization
# server ships, so reach it from a tunnel that shares the container's network
# namespace (compose `network_mode: "service:mcp"`), never by publishing the
# port to a routable host interface.
ENV MCP_TRANSPORT=http
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
EXPOSE 4243
# The distroless nodejs image's ENTRYPOINT is ["/nodejs/bin/node"]; pass only
# the entry script. Keychain (@napi-rs/keyring) is unavailable here (no D-Bus), so
# key provisioning degrades to the 0600 file under a mounted config volume —
# persist that volume across restarts or MASTER_KEY regenerates and bricks tokens.
CMD ["dist/index.js"]
