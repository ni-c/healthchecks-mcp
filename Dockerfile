# Build stage
#
# node:24-alpine is the ACTIVE LTS line, not the newest tag — roughly half of all
# Node majors never become LTS, so "newest" and "supported" are different things.
# What keeps this honest is a comparison, not a version number written down here:
# `node:lts-alpine` and `node:24-alpine` MUST resolve to the same digest. The day
# 24 leaves LTS they diverge, and that is visible; a hardcoded version in a comment
# is not. Verified 2026-09-07: both resolve to the digest below, Node 24.20.0.
# Refresh the digest and re-run that comparison together — a stale tag is
# invisible if only the digest is re-resolved.
FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

# Runtime
FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81
WORKDIR /app
ENV NODE_ENV=production

# The pinned digest is the newest node:24-alpine, and as of 2026-09-07 it still
# ships OpenSSL 3.5.7-r0 (`apk list -I | grep libssl3` in the base image) —
# CVE-2026-14456, unbounded memory growth, fixed in 3.5.8-r0. Named
# packages only: a blanket `apk upgrade` would move every package in the image
# and throw away the reproducibility the digest is pinned for. Drop this line
# once the base image carries 3.5.8-r0 or later.
RUN apk add --no-cache --upgrade libcrypto3 libssl3

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The server reports its version from package.json at runtime. The lockfile is
# deliberately NOT copied: nothing reads it here, and a dependency manifest in a
# runtime image is one more thing to keep accurate for no benefit.
COPY package.json ./

# What the base image ships that this one has no use for. npm is a frequent
# source of HIGH findings and this image never installs anything; yarn and
# corepack are two more package managers with the same argument against them,
# and they were left behind when npm was removed. `docker run --entrypoint sh
# <image> -c 'ls /opt /usr/local/lib/node_modules; which yarn npm npx corepack'`
# is how to check that they are gone.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/lib/node_modules/corepack /usr/local/bin/corepack \
    /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Ownership proof for the MCP Registry: must match server.json's name exactly.
LABEL io.modelcontextprotocol.server.name="io.github.ni-c/healthchecks-mcp"

# Drop root: the node image ships an unprivileged `node` user (uid 1000).
USER node

# stdio transport only — no port, no healthcheck. The server starts without an
# API key (tools stay listable, so registries and inspectors can introspect it);
# every call then fails with setup instructions instead of reaching the API.
ENTRYPOINT ["node", "dist/index.js"]
