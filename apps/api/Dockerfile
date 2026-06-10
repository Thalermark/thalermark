# syntax=docker/dockerfile:1.7
#
# Multi-stage build for @thalermark/api.
#
# Build context is the repo root (see docker-compose.yml). The build copies
# only what's needed at each layer so unrelated changes (web sources, other
# packages' source) don't bust the dependency-install cache.
#
# Stage layout:
#   base    — pnpm-enabled node image
#   deps    — `pnpm install` against the lockfile + workspace manifests only
#   builder — full source + `pnpm deploy` to produce a self-contained slice
#   runner  — minimal image holding only the deployed slice
#
# Node 24 supports stripping TypeScript types at runtime, so we ship the .ts
# sources rather than a separate compile step. Compile-to-JS can be added
# later if startup overhead becomes a concern.

ARG NODE_VERSION=24-alpine
ARG PNPM_VERSION=9.15.0

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS base
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

# ---------------------------------------------------------------------------
FROM base AS deps
# Copy only lockfile + workspace manifests so this layer is cached as long
# as no dependencies change. Update this list when a new workspace package
# is added.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/ai/package.json packages/ai/
COPY packages/auth/package.json packages/auth/
COPY packages/db/package.json packages/db/
COPY packages/location/package.json packages/location/
COPY packages/logger/package.json packages/logger/
COPY packages/storage/package.json packages/storage/
COPY packages/telemetry/package.json packages/telemetry/
COPY packages/validation/package.json packages/validation/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
FROM deps AS builder
COPY apps/api ./apps/api
COPY packages ./packages
COPY tsconfig.base.json ./
# Build every workspace dep apps/api consumes at runtime — Node 24's
# --experimental-strip-types refuses to strip TS from files inside
# node_modules, so each dep must ship as JS in the deployed slice.
# Order respects the workspace dep graph: logger / db / validation / storage /
# ai / location have no workspace deps; auth needs db; telemetry needs db+logger.
RUN pnpm --filter=@thalermark/logger build \
 && pnpm --filter=@thalermark/db build \
 && pnpm --filter=@thalermark/validation build \
 && pnpm --filter=@thalermark/storage build \
 && pnpm --filter=@thalermark/ai build \
 && pnpm --filter=@thalermark/location build \
 && pnpm --filter=@thalermark/auth build \
 && pnpm --filter=@thalermark/telemetry build
# Now compile @thalermark/api's own TypeScript to ./apps/api/dist.
RUN pnpm --filter=@thalermark/api build
# `pnpm deploy` materialises @thalermark/api with all of its prod deps copied
# (not symlinked) into /out. The package's `files` field constrains the local
# slice to ./dist, but workspace deps land in /out/node_modules with their
# .ts sources intact (their package.json declares src/ as the main entry).
RUN pnpm deploy --filter=@thalermark/api --prod /out

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /out ./

# Drop privileges. The deployed slice is read-only for the app user.
RUN addgroup -S app && adduser -S -G app app && chown -R app:app /app
USER app

EXPOSE 3000

# Node's built-in fetch is enough — no need to add curl/wget to the image.
# Compose / orchestrators get the same signal from this as from an external
# probe. A 30s interval keeps log noise low while still catching wedged
# processes within a minute or two.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--experimental-strip-types", "dist/server.js"]
