# syntax=docker/dockerfile:1.7
#
# Multi-stage build for @thalermark/web.
#
# Build context is the repo root (see docker-compose.yml). The build copies
# only what's needed at each layer so unrelated changes (api sources, other
# packages' source) don't bust the dependency-install cache.
#
# Stage layout:
#   base    — pnpm-enabled node image
#   deps    — `pnpm install` against the lockfile + workspace manifests only
#   builder — full source + `pnpm deploy` to produce a self-contained slice
#   runner  — minimal image holding only the deployed slice
#
# SvelteKit's adapter-node bundles everything reachable from the routes into
# build/, so the runner only needs build/ + prod node_modules. PUBLIC_API_URL
# is consumed via `$env/dynamic/public` at request time, not baked in — the
# same image runs across self-host deployments.

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
COPY apps/web/package.json apps/web/
COPY packages/brand/package.json packages/brand/
COPY packages/api-contract/package.json packages/api-contract/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
FROM deps AS builder
COPY apps/web ./apps/web
COPY packages ./packages
COPY tsconfig.base.json ./
RUN pnpm --filter=@thalermark/web build
# `pnpm deploy` materialises @thalermark/web with all of its prod deps copied
# (not symlinked) into /out. The package's `files` field constrains the local
# slice to ./build; workspace deps (@thalermark/brand, @thalermark/api-contract)
# are bundled into build/ by Vite at build time and don't need to be loaded
# from node_modules at runtime, but pnpm copies them anyway as they're listed
# as deps — harmless.
RUN pnpm deploy --filter=@thalermark/web --prod /out

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /out ./

# Drop privileges. The deployed slice is read-only for the app user.
RUN addgroup -S app && adduser -S -G app app && chown -R app:app /app
USER app

EXPOSE 3000

# adapter-node serves /sign-in publicly (PUBLIC_PATHS in hooks.server.ts).
# A 200 there proves SSR is up. The page's loadSession() call to /api/me
# fails fast and returns null when the API is down, so this healthcheck
# doesn't couple web liveness to api liveness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/sign-in').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "build/index.js"]
