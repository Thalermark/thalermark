# Scaffolding Plan

**Status:** Phases 0, 1, 2, 3, 4, and 5 shipped (2026-05-21). Phase 6 (mobile shell) is up next.
**Reads:** Assumes you've read PROJECT.md and TECH-STACK.md.

The shape of work between "all decisions locked" and "writing actual MVP features." Eight phases, roughly sequential — each builds on the previous one. None of the actual MVP feature code is in here; this is just the foundation.

---

## Phase overview

| Phase | What gets built | Why this order | Status |
|---|---|---|---|
| **0** | Repo skeleton + tooling | Everything else lives in here | ✅ Shipped |
| **1** | Database foundation + RLS | Every other layer assumes the DB is right | ✅ Shipped (slices 1.1–1.6, PRs #11–#19) |
| **2** | Telemetry module | Trust signal; build *before* features so the patterns are established | ✅ Shipped (slices 2.1–2.4, PRs #22–#25) |
| **3** | API foundation (Hono + Better Auth) | Web and mobile both need it to do anything | ✅ Shipped (slices 3.1–3.7, PRs #26, #30, #36–#40) |
| **4** | Shared packages (validation, AI, location, brand) | Web/mobile/api all consume them | ✅ Shipped (slice 4.1, PR #42 — others deferred to feature consumers) |
| **5** | Web app shell (SvelteKit) | Auth flows, layout, empty home | ✅ Shipped (slices 5.1, 5.3–5.5, PRs #44, #50–#52 — 5.2 folded into 5.3) |
| **6** | Mobile app shell (Expo) | Same shape, native shell | ⬅ Next |
| **7** | CI/CD and self-host story | Docker compose for self-hosters, GHA for us | — |

After Phase 7, the foundation is real and we start building actual MVP features (invoice → expense → payment → dashboard → AI).

---

## Phase 0 — Repo skeleton + tooling

The bones. Goal: `pnpm install` and `pnpm build` both succeed on an empty repo.

**Files created:**
```
/.gitignore
/.editorconfig
/.nvmrc                   # Node 24 LTS
/package.json             # root workspace
/pnpm-workspace.yaml
/turbo.json
/biome.json
/tsconfig.base.json
/.github/workflows/ci.yml
/LICENSE                  # AGPL v3 full text
/LICENSE-COMMERCIAL.md
/CLA.md
/CONTRIBUTING.md
/README.md
/.env.example
/docker/docker-compose.yml      # postgres + caddy initially
/docker/docker-compose.dev.yml
/PROJECT.md, /TECH-STACK.md, /TELEMETRY.md  # already exist
```

**Key picks not yet explicit:**
- **Node version:** 24 LTS (locked) — went LTS October 2025, runway until April 2028
- **Postgres version:** 17 (locked) — drizzle-kit shipping PG 18 fixes recently flagged it as too fresh for a financial app; 20 months of ecosystem maturity on 17. UUIDv7 generated app-side via `uuid` npm package.
- **Package manager:** pnpm 9.x

**Validation:** `pnpm install` works, Biome lints an empty workspace, Vitest runs an empty test suite, Turborepo orchestrates a no-op build.

**Realized:** shipped in early PRs along with a production-readiness pass (signed commits, PR-required branch protection, Dependabot, CodeQL, secret scanning, SECURITY.md). See `spikes/PRODUCTION-READINESS.md` for the full log.

---

## Phase 1 — Database foundation + RLS

The thing every other phase assumes. Most likely to be subtly wrong if rushed.

**Created in `/packages/db/`:**
```
src/
├── schema/
│   ├── accounts.ts        # The paying customer / workspace
│   ├── companies.ts       # Multi-company within account
│   ├── users.ts           # Better Auth's user table
│   ├── memberships.ts     # user ↔ account, role
│   ├── audit_events.ts    # Append-only log
│   └── index.ts
├── policies/
│   ├── 001_enable_rls.sql
│   ├── 002_account_isolation.sql
│   ├── 003_company_isolation.sql
│   └── 004_audit_events_append_only.sql
├── client.ts              # Drizzle client w/ transaction-scoped RLS context
├── migrate.ts
└── seed.ts                # Dev seed data
drizzle.config.ts
```

**Key implementation details:**
- Every tenant-scoped table gets `account_id` (and `company_id` where applicable)
- RLS policies enforce isolation at the DB layer — `current_setting('app.current_account_id')`
- Connection helper wraps every request in a transaction and runs `SET LOCAL app.current_account_id = ...` first
- `audit_events` is append-only — RLS policy forbids UPDATE and DELETE
- Migrations via drizzle-kit; SQL policy files applied alongside

**Validation tests (Vitest + pgTAP-style):**
- "User in account A cannot see records from account B" — must pass
- "User in account A cannot insert with account_id of account B" — must fail
- "Cannot UPDATE or DELETE an audit_events row" — must fail
- These tests run against a real Postgres (via Docker), not mocks

**Realized (slice numbering):**

| Slice | PR | What landed |
|---|---|---|
| 1.1 | #11 | `@thalermark/db` package skeleton, `drizzle.config.ts`, drizzle:generate + drizzle:migrate scripts |
| 1.2a | #12 | `accounts` table (first domain table) |
| 1.2b | #13 | testcontainers wired (`pgvector/pgvector:pg17`), first integration test passes in CI |
| 1.3a | #14 | `companies` table (FK → accounts, cascade) |
| 1.3b | #15 | Better Auth schema tables: `auth_user`, `auth_session`, `auth_account`, `auth_verification` |
| 1.3c | #16 | `memberships` table (user ↔ account join, composite unique) |
| 1.4 | #17 | RLS foundations + staff support roles (`thalermark_app`, `thalermark_staff_readonly`); `withAccountContext` helper |
| 1.5 | #18 | Full RLS isolation matrix + `NULLIF(..., '')::uuid` fix-up for unset GUCs |
| 1.6 | #19 | `audit_events` table + append-only RLS + synthetic system user (`SYSTEM_USER_ID`) |

---

## Phase 2 — Telemetry module

Built *before* MVP features. The pattern matters: every feature checks `telemetry.event()` exists and uses it, but only emits when the user has opted in.

**Created in `/packages/telemetry/`:**
```
src/
├── client.ts            # Opt-in check, batched send, local-first
├── events/              # Typed event definitions
├── transport/
│   ├── local.ts         # Default: store locally, never send
│   └── http.ts          # Send to Thalermark endpoint if opted in
└── index.ts
```

**Implementation:**
- Events are typed (`type FeatureUsedEvent = {...}`)
- Default transport is local-only (writes to a `telemetry_events` table or local file for self-host)
- Opt-in flag in settings flips the transport to HTTP send
- Endpoint receives anonymous, batched, signed payloads
- Full spec already documented in TELEMETRY.md — this implements it

**Realized (slice numbering):**

| Slice | PR | What landed |
|---|---|---|
| 2.1 | #22 | `@thalermark/telemetry` package skeleton; discriminated `Event` union covering every event from TELEMETRY.md; `InstallContext` envelope; no-op `emit(event)` placeholder |
| 2.2 | #23 | `accounts.telemetry_enabled` + `accounts.telemetry_install_id`; new `telemetry_events` staging table (not append-only — RLS allows tenant-scoped DELETE/UPDATE so the transport can drain on send and opt-out can purge); staff readonly bypass kept SELECT-only |
| 2.3 | #24 | `emit(tx, event)` (reads accounts row via RLS, bails if opt-in false, INSERTs into the staging queue); `enableTelemetry(tx)` / `disableTelemetry(tx)` helpers; **each opt-in rotates `telemetry_install_id`** so post-opt-out events can never be correlated with prior history |
| 2.4 | #25 | HMAC-signed HTTP transport with retry: `flushTelemetry(db, accountId, config?, fetchImpl?)` (short read tx → POST outside any tx → short write tx) + `scheduleTelemetryFlush(db, accountId)` fire-and-forget after-commit hook. Migration 0012 adds `retry_count` + `last_attempt_at`. Two-key gating: `TELEMETRY_TRANSPORT_ENABLED` deployment-wide kill switch AND `accounts.telemetry_enabled` per-tenant opt-in both required |

---

## Phase 3 — API foundation (Hono + Better Auth)

**Created in `/apps/api/`:**
```
src/
├── server.ts             # Hono app + serve()
├── middleware/
│   ├── rls-context.ts    # SET LOCAL app.current_account_id, company_id, user_id
│   ├── audit-log.ts      # Auto-write audit_events on mutations
│   └── error.ts
├── routes/
│   ├── auth.ts           # Better Auth handler at /api/auth/*
│   ├── health.ts
│   └── index.ts          # Hono RPC export
├── lib/
│   ├── auth.ts           # Better Auth config (Drizzle adapter, orgs plugin)
│   └── db.ts             # Drizzle client w/ pg-boss
└── env.ts
Dockerfile
```

**Implementation:**
- Better Auth configured with Drizzle adapter, organizations plugin, email/password + Google OAuth
- Every mutation route runs through the audit-log middleware → writes to `audit_events`
- RLS context middleware extracts account/company/user from session, sets them per-transaction
- `export type AppType = typeof app` for Hono RPC clients

**Validation:** `pnpm dev` brings up the API. Health route returns 200. Sign-up creates a user + account + initial company in one flow.

**Realized (slice numbering):**

| Slice | PR | What landed |
|---|---|---|
| 3.1 | #26 | `apps/api` Hono skeleton + `@hono/node-server` + typed `env.ts` + `/health` route + 4-stage Dockerfile (Node 24 alpine, pnpm via corepack, `pnpm deploy` slice, non-root, healthcheck). `createApp()` factory pattern so tests mount the app without binding a port |
| 3.2 | #30 | `@thalermark/logger` LogTape wrapper + Sentry init in `apps/api`. `packages/telemetry/src/flush.ts` console calls swapped over as the first real consumer |
| 3.3 | #36 | `apps/api/src/lib/db.ts` (Pool + Drizzle, idempotent close); `MIGRATE_ON_BOOT` env (default false); graceful pool drain on SIGTERM/SIGINT; `@thalermark/db` exports `migrationsFolder` constant |
| 3.4 | #37 | `@thalermark/auth` package wraps Better Auth's Drizzle adapter onto the existing `auth_*` schema (no migrations — Phase 1 had already created BA-compatible columns). Email+password ON; orgs OFF (tenancy stays in our `accounts`/`memberships`); uuidv7 generateId. `BETTER_AUTH_SECRET` + `BETTER_AUTH_URL` required at boot |
| 3.5 | #38 | RLS context middleware on `/api/*`: 401 no session → 400 missing/malformed `x-account-id` → 403 non-member → `withAccountContext` exposes `tx`/`accountId`/`userId` via typed Hono `Variables`. Bootstrap exemption for `/api/me`. Migration 0013 adds `auth_user.last_account_id` (cross-device anchor) |
| 3.6 | #39 | Audit helper bound via Hono `Variables`: `c.var.audit({entityType, entityId, action, before?, after?, companyId?})` inserts into `audit_events` inside the request's tenant tx (atomic; rolls back on throw via re-throw inside the tx callback). Middleware tracks "did handler call audit()" via closure flag; on commit, fire-and-forget `scheduleTelemetryFlush(db, accountId)` runs **only for writes** — reads pay no per-request opt-in lookup. First real call site for the Phase 2 staging-queue drain |
| 3.7 | #40 | `createApp` rewritten with Hono's chained builder so `AppType` carries route signatures end-to-end (the prior non-chained `app.method()` pattern erased the type to an empty `Hono`; Phase 4's `hc<AppType>()` clients would have typed as `any`). `/api/me` keeps `{user, memberships}` shape with a defensive 401 if `auth_user` row vanished. New `e2e-pipeline.integration.test.ts` exercises sign-up → bootstrap → seed → authed mutating request → audit row + telemetry queue row + scheduleFlush trigger in one test |

**Realized structure differs from the plan above:**

- No `routes/` directory — every route is defined inline on the chained Hono builder in `src/app.ts`. The chain is load-bearing for `AppType` and broke the moment we tried to split routes into multiple files; revisit only with a Hono-RPC-aware splitting pattern.
- `middleware/audit.ts` instead of `middleware/audit-log.ts`, and **not auto-write**. True auto-write would require either PG triggers (loses semantic action names like `invoice.paid`, only sees CRUD verbs) or Drizzle interceptors (brittle, ORM-coupled). Handlers call `c.var.audit(...)` explicitly; the middleware just binds `tx`/`account`/`actor` so the call is one line and atomic with the business write.
- No `middleware/error.ts` — Hono's default has been sufficient. Add when a real cross-cutting error need shows up.
- `lib/db.ts` exists but pg-boss is deferred until the first feature needs background work. The exact job shape (cron vs queue vs fan-out) will be clearer when we know what's calling it.
- `env.ts` lives at `src/env.ts`, not under `lib/`.
- `@thalermark/logger` (LogTape wrapper) and `@thalermark/auth` (Better Auth factory) were added as their own packages so `apps/api` doesn't own the wiring of either upstream.
- Google OAuth provider is deferred to a pre-launch parking lot — UX polish, not infrastructure. Drop-in via Better Auth's plugin model once credentials are provisioned and a sign-in UI exists.
- Sign-up creating "an initial company in one flow" did not land — multi-company-per-account is part of the MVP feature phase, not the foundation. Sign-up creates an `auth_user` only; `/api/me` returns empty memberships until a feature explicitly seeds them.

---

## Phase 4 — Shared packages

Built in parallel after Phase 3. All consumed by web and mobile.

**`/packages/validation/`** — Zod schemas
- `invoice.ts`, `estimate.ts`, `expense.ts`, `customer.ts`, etc.
- One schema per entity, shared between server validation, client forms, and `drizzle-zod` for the DB

**`/packages/ai/`** — Vercel AI SDK setup
- Provider abstraction (Anthropic default, OpenAI, Ollama all wired)
- BYOK env var resolution
- Receipt extraction function
- Insight generation functions (empty stubs initially, filled in MVP feature phases)

**`/packages/location/`** — Address autocomplete provider abstraction
- `AddressAutocompleteProvider` interface
- Mapbox adapter
- Nominatim adapter (self-host fallback, no key)
- Provider resolution from env

**`/packages/brand/`** — Brand constants
- Name, colors, default copy strings
- Used by web, mobile, email templates, PDF templates

**`/packages/api-contract/`** — Type re-export
- Re-exports `AppType` from `apps/api`
- Web and mobile import from here, not directly from `apps/api`

**Realized (slice numbering):**

| Slice | PR | What landed |
|---|---|---|
| 4.1 | #42 | `@thalermark/api-contract` package: `src/index.ts` is a single `export type { AppType } from '@thalermark/api'`. `apps/api/package.json` gained `"types": "./src/app.ts"` so type-only consumers don't need the dist build (main stays at `dist/server.js` for runtime). Test calls `hc<AppType>('http://localhost')` and accesses `client.api.me.$get` — if `app.ts` ever breaks the chained Hono builder (slice 3.7's load-bearing pattern), `AppType` erases to empty `Hono` and `tsc` fails before vitest runs. |

**Deferred to feature consumers:**

The other four packages from the plan above are feature-coupled — scaffolding them empty in Phase 4 would be infrastructure for hypothetical consumers, the same anti-pattern that justified deferring `pg-boss` in Phase 3. They land with the first feature that needs them:

- **`packages/validation`** — first Zod schema lands with the first MVP feature (invoice).
- **`packages/ai`** — Vercel AI SDK provider abstraction lands with the first AI feature (cash flow nudge, late payer, anomaly, or receipt extraction — whichever ships first).
- **`packages/location`** — Mapbox + Nominatim address autocomplete lands with the customer-creation flow.
- **`packages/brand`** — name/colors/copy constants land when Phase 5 (web shell) actually needs them for Tailwind tokens.

---

## Phase 5 — Web app shell (SvelteKit)

**Created in `/apps/web/`:**
```
src/
├── lib/
│   ├── api.ts           # hc<AppType> client
│   ├── auth.ts          # Better Auth client
│   └── stores/
├── routes/
│   ├── +layout.svelte   # App shell w/ company switcher
│   ├── +page.svelte     # Home (empty)
│   ├── (auth)/
│   │   ├── sign-in/
│   │   ├── sign-up/
│   │   └── accept-invite/
│   └── (app)/
│       └── +layout.svelte  # Authed shell
├── app.html
└── app.css                  # Tailwind base, brand tokens from packages/brand
```

**Validation:** Visit `/sign-up`, create an account, land on an empty authed home with a company switcher in the nav. Sign out works. Accept-invite flow works end-to-end.

**Realized (slice numbering):**

| Slice | PR | What landed |
|---|---|---|
| 5.1 | #44 | `apps/web/` scaffolded: SvelteKit 2 + Svelte 5 (runes) + adapter-node + Tailwind v3, wired into Turborepo + pnpm. `packages/brand/` lands JIT as the first consumer: `PRODUCT_NAME/TAGLINE/DOMAIN`, primary/accent palette, `INITIAL_BUBBLE_PALETTE` + deterministic `initialBubbleColor()`, `COPY` map for auth/switcher. `tailwind.config.ts` imports `COLORS` directly so brand tokens have one source of truth. `biome.json` ignores `**/*.svelte` (Biome 1.9 can't lint Svelte; svelte-check handles those). Blank `+page.svelte` renders the product name. |
| 5.2 | — | Folded into 5.3. The api-contract test in #42 already validated the `AppType` contract at tsc time; runtime confidence was mostly env/URL/CORS plumbing that 5.3's BA client exercises anyway. `src/lib/api.ts` + `PUBLIC_API_URL` env wiring landed inside #50. |
| 5.3 | #50 | Better Auth client + auth routes + `hc<AppType>()` wiring. `src/lib/api.ts` (hc factory; `credentials: 'include'` for browser, `extraHeaders` for SSR cookie forwarding); `src/lib/auth-client.ts` (BA's `createAuthClient` from `better-auth/svelte`); `src/hooks.server.ts` (forwards incoming cookie to `apps/api /api/me`, populates `event.locals.session`, redirects: `/sign-{in,up}` → `/` when authed, `/accept-invite` always renders, everything else → `/sign-in` when anonymous). New `(auth)/{sign-in,sign-up,accept-invite}` route group + `(app)/` placeholder group. Split-app arch: we use `better-auth/svelte` but NOT `better-auth/svelte-kit` because BA is hosted in `apps/api`. Known gap deferred to 5.4: BA's `trustedOrigins` unset on apps/api → curl works but browser POST `/api/auth/sign-up/email` from `:5173` → `:3000` hits CORS. |
| 5.4 | #51 | Authed shell + company switcher + browser CORS fix. **apps/api:** new `TRUSTED_ORIGINS` env (comma-separated allowlist) threaded through `createApiAuth` → BA `trustedOrigins` + Hono `cors()` middleware on `/api/*` (credentials:true, allows `x-account-id`). `server.ts` loads project-root `.env` at boot via `node:process.loadEnvFile`, resolved from `import.meta.dirname` because pnpm `--filter` sets cwd to the package dir. **apps/web:** `hooks.server.ts` membership routing — 0 → forced to `/select-company` (sign-up-incomplete UI), 1 → auto-set `active_company_id` cookie + `locals.activeCompanyId`, 2+ no/stale cookie → redirect to `/select-company`. New `lib/components/{UserMenu,AvatarBubble}.svelte` (initials, deterministic color via `initialBubbleColor`, dropdown with outside-click + Escape). New `(app)/select-company/+page.{server.ts,svelte}` with form action setting the cookie. sign-in / sign-up / sign-out switched to `window.location.assign(...)` — `goto()` + `invalidateAll()` left stale client-side layout data and skipped the fresh `hooks.server.ts` run that membership routing needs. Cookie name footgun acknowledged: `active_company_id` per locked plan, but the value currently holds an `account_id` UUID. Accept-invite flow split out of 5.4 into a new 5.5 slice because no invitations table / API / email transport existed yet. |
| 5.5 | #52 | Accept-invite end-to-end + account-on-signup hook. New `invitations` table (migration 0014) + RLS (migration 0015; account-scoped SELECT/INSERT/UPDATE; accept endpoint runs outside RLS via the bootstrap path because the accepting user is not yet a member). Schema: `id, account_id, email, token (unique), invited_by_user_id, expires_at, accepted_at, accepted_by_user_id`. 7-day TTL, `randomBytes(32).toString('hex')` token. **API:** `POST /api/invitations` (account-scoped, lowercases email, console-logs `[invite] account=... email=... url=...`); `POST /api/invitations/:token/accept` (bootstrap; matches token + authed email; idempotent membership insert; stamps `accepted_at`/`accepted_by`). 404 unknown / 410 expired / 403 email-mismatch. `rls-context` middleware `BOOTSTRAP_PATHS` upgraded from `Set<string>` to regex patterns so `:token` path-param routes can opt in. **Account-on-signup hook** (Better Auth `databaseHooks.user.create.after` in `@thalermark/auth`) creates `accounts` + `memberships` rows in one tx — closes the 0-membership trap from 5.4. **UI:** `(auth)/accept-invite/+page.svelte` reads `?token=`; unauthed → "Sign in / Create account" links carrying `?invite=<token>`; authed → auto-POSTs accept then `window.location.assign('/')`. sign-in + sign-up read `?invite=` and redirect to `/accept-invite?token=...` after auth. Account-side invite compose UI dropped to post-MVP (exercise via curl); email transport still stubbed. |

**Realized structure differs from the plan above:**

- **Slice 5.2 was folded into 5.3.** Phase 4's api-contract test already proves `AppType` at compile time; a standalone hc-smoke-test slice would have duplicated work and delayed the BA client. Net: 5.3 absorbed `src/lib/api.ts` + `PUBLIC_API_URL` wiring.
- **`lib/auth.ts` is `lib/auth-client.ts`.** Names the client wrapper distinctly from the server-side `@thalermark/auth` package consumed by `apps/api`. No shared types live here yet; the BA SvelteKit adapter is intentionally NOT used because BA is hosted in `apps/api`, not in SvelteKit.
- **`lib/stores/` was not built.** Svelte 5 runes (`$state`, `$derived`, `page.data`) covered every Phase 5 need; a global store layer would have been premature abstraction.
- **Company switcher lives at `(app)/select-company`, not inline in the nav.** Locked UX decision 2026-05-19: MVP user is overwhelmingly single-company; tucking the switcher behind the avatar menu → Account link keeps the chrome clean. Forced redirect to `/select-company` only fires when ≥2 memberships exist with no/stale active cookie. Accountant tier (post-MVP) is where prominent switching matters.
- **Cookie name footgun:** the active-tenant cookie is literally `active_company_id` per the locked plan, but the value is currently an `account_id` UUID because memberships are at the account level in MVP. A future companies-level picker can promote the value without renaming the cookie. Documented inline in `hooks.server.ts`.
- **Account-on-signup hook landed in `@thalermark/auth`, not `apps/api`.** Better Auth's `databaseHooks.user.create.after` is closest to the user-creation transaction, and putting the hook next to `createAuth` keeps the seeding pattern in one place for both web and (future) mobile sign-ups.
- **Email transport still stubbed.** Locked UX decision 2026-05-19: stubbed for the entire phase. Real transport (Resend SaaS, SMTP self-host) is a separate decision deferred to pre-launch. Operators read the accept URL from `apps/api` stdout for now.
- **Hard navigation (`window.location.assign`) after auth state transitions.** `goto()` + `invalidateAll()` left stale client-side layout data and skipped the fresh `hooks.server.ts` run that membership routing depends on. Discovered in browser validation when post-sign-in `goto('/')` did not redirect to `/select-company` despite the cookie being correct. Now used consistently on sign-in / sign-up / sign-out / accept-invite success.
- **`apps/api/server.ts` loads project-root `.env` at boot.** `pnpm --filter @thalermark/api dev` sets cwd to `apps/api/`, not the repo root, so `tsx watch` was failing to find `DATABASE_URL`. The `loadEnvFile(resolve(import.meta.dirname, '../../../.env'))` pattern matches `drizzle.config.ts`. Container deploys pass env vars directly and skip the file via the try/catch.
- **`emit()` footgun surfaced under the signup hook.** `packages/telemetry`'s `emit(tx, …)` reads the current account row via `LIMIT 1` and relies on RLS to scope the select. The API integration tests run as the testcontainer superuser (BYPASSRLS), so they previously only worked because there was exactly one account in the DB. With the signup hook now seeding a second account, the e2e-pipeline test had to `DELETE FROM accounts` before seeding its purpose-built tenant. Not a prod concern (prod runs as `thalermark_app` with RLS enforced), but worth flagging for whoever splits `apps/api` to a non-superuser pool.

---

## Phase 6 — Mobile app shell (Expo)

**Created in `/apps/mobile/`:**
```
app/
├── _layout.tsx
├── (auth)/
│   ├── sign-in.tsx
│   ├── sign-up.tsx
│   └── accept-invite.tsx
├── (app)/
│   ├── _layout.tsx     # Tab nav skeleton
│   └── index.tsx       # Home (empty)
├── lib/
│   ├── api.ts          # hc<AppType> client w/ bearer token
│   ├── auth.ts         # Better Auth client + Keychain/Keystore
│   └── secure-store.ts
```

**Validation:** Sign up via mobile app, get a bearer token stored in Keychain (iOS) / Keystore (Android), land on the home tab. Sign out clears the token.

---

## Phase 7 — CI/CD and self-host story

**GitHub Actions** (`.github/workflows/ci.yml`):
- Run on every PR: lint (Biome), typecheck, test (Vitest), build (Turborepo)
- Test job spins up Postgres in a service container
- CLA Assistant bot enforces signatures
- Mobile builds via Expo EAS, not in GHA

**Docker compose** (`/docker/docker-compose.yml`) — the self-host story:
- `postgres:17` with `pgvector` extension
- `api` (Hono, built from `/apps/api/Dockerfile`)
- `web` (SvelteKit, built from `/apps/web/Dockerfile`)
- `caddy` with auto-TLS config
- Single `docker compose up` brings it all up
- `.env` file for config

**Validation:** Fresh checkout, `docker compose up`, browser to `https://localhost`, full sign-up + sign-in flow works.

---

## Things to decide before we start

A few small picks to confirm:

1. ~~**Node version**~~ — ✅ Node 24 LTS (locked 2026-05-11)
2. ~~**Postgres version**~~ — ✅ PG 17 (locked 2026-05-11). UUIDv7 generated app-side via `uuid` npm package.
3. ~~**GitHub repo**~~ — ✅ GitHub org created at `github.com/Thalermark`. Main monorepo will be `Thalermark/thalermark`, public from first commit. CLA Assistant bot installed at org level. Security policy (`SECURITY.md`) shipped with v0.
4. ~~**Tailwind on web**~~ — ✅ Tailwind CSS (locked 2026-05-11). Brand tokens defined once in `packages/brand`, consumed by Tailwind config.
5. ~~**Mobile UI library**~~ — ✅ NativeWind (locked 2026-05-11). Same mental model as web Tailwind; shared brand tokens flow into both. Tamagui rejected — unified components are powerful but the consistency-via-same-classnames story wins for a solo developer.

These are small. Could be answered in one message.

---

## Timing estimate (honest)

Working solo with focus, the foundation phases (0–7) before the first MVP feature is probably:

| Phase | Estimate |
|---|---|
| 0 + 1 | ~3-5 days |
| 2 | ~2-3 days |
| 3 | ~3-5 days |
| 4 | ~2-3 days (in parallel with 5+6) |
| 5 + 6 | ~5-7 days each |
| 7 | ~2-3 days |

Total foundation: ~3-4 weeks of focused work before the first MVP feature lands. After that, MVP features are faster because the patterns are established.

These are rough; first-time-doing-this estimates always slip. The point is to give a sense of scale, not a commitment.

---

## Build order after scaffolding

Per CLAUDE.md, once Phases 0-7 are done:

1. **DB schema for core entities** — invoices, estimates, expenses, customers, recurring rules (built during Phase 1 in skeleton form, fleshed out as features land)
2. **MVP features in dependency order:**
   - Invoice (the centerpiece)
   - Estimate (shares invoice model)
   - Customer management (required by invoice)
   - Public invoice view + Stripe pay
   - Recurring invoice rules
   - Expense + receipt capture
   - Receipt extraction (AI)
   - Position dashboard
   - AI insights layer (cash flow, late payer, anomaly, categorization)
   - Audit trail UI (data layer is from Phase 1, UI lands here)
3. **Polish + ship**
