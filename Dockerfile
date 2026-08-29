# Build stage
# node:24-alpine is the ACTIVE LTS line (Krypton), not the newest tag — 26 exists
# and is not LTS. The digest is the one that tag pointed at on 2026-08-29.
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

# Runtime
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf
WORKDIR /app
ENV NODE_ENV=production

# The pinned digest is the newest node:24-alpine, and it still ships OpenSSL
# 3.5.7-r0 — CVE-2026-14456, unbounded memory growth, fixed in 3.5.8-r0. Named
# packages only: a blanket `apk upgrade` would move every package in the image
# and throw away the reproducibility the digest is pinned for. Drop this line
# once the base image carries 3.5.8-r0 or later.
RUN apk add --no-cache --upgrade libcrypto3 libssl3

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The server reports its version from package.json at runtime.
COPY package.json package-lock.json ./

# The base image's bundled npm is a frequent source of HIGH findings and this
# image never installs anything — remove it rather than carrying its CVEs.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Ownership proof for the MCP Registry: must match server.json's name exactly.
LABEL io.modelcontextprotocol.server.name="io.github.ni-c/healthchecks-mcp"

# Drop root: the node image ships an unprivileged `node` user (uid 1000).
USER node

# stdio transport only — no port, no healthcheck. The server starts without an
# API key (tools stay listable, so registries and inspectors can introspect it);
# every call then fails with setup instructions instead of reaching the API.
ENTRYPOINT ["node", "dist/index.js"]
