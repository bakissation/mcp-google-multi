# syntax=docker/dockerfile:1
# B16 + P3: distroless Node 22, non-root, single-file esbuild bundle. The
# runtime carries the 6 MB bundle instead of ~70 MB of node_modules; the only
# module kept on disk is @napi-rs/keyring (native, external to the bundle —
# harmless here: no D-Bus means key provisioning falls back to the 0600 file
# under the config volume anyway). No secrets are ever baked in — pass them at
# runtime via --env-file / orchestrator secrets (deploy/compose.yaml,
# docs/http-setup.md). Run with `docker run --init` so SIGTERM reaches node
# (distroless has no init to reap PID 1).

# --- build stage -----------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm run bundle

# --- runtime stage ---------------------------------------------------------
FROM gcr.io/distroless/nodejs22-debian13:nonroot
WORKDIR /app
ENV NODE_ENV=production
# HTTP transport by default, bound to loopback (MCP_HTTP_HOST=127.0.0.1).
# Expose it through a tunnel that shares the container's network namespace
# (compose `network_mode: "service:mcp"`) or a TLS reverse proxy on an internal
# network with MCP_HTTP_HOST=0.0.0.0 (deploy/compose.yaml caddy profile); the
# OAuth AS (Bearer auth + Host/Origin guard, B13) fronts every request. Never
# publish the port itself on a routable host interface.
ENV MCP_TRANSPORT=http
COPY --from=build /app/bundle/index.js ./dist/index.js
COPY --from=build /app/node_modules/@napi-rs ./node_modules/@napi-rs
COPY --from=build /app/package.json ./package.json
EXPOSE 4243
# The distroless nodejs image's ENTRYPOINT is ["/nodejs/bin/node"]; pass only
# the entry script.
CMD ["dist/index.js"]
