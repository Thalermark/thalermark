# Scaffolding Plan

**Status:** Phases 0–7 shipped (2026-05-23); Phase 8 (MVP features) in progress — slices 8.1–8.4f, 8.5a–8.5c, 8.6a–8.6c, 8.7a–8.7e, 8.8a–8.8b merged (latest 2026-05-27). Invoice CRUD + status flow, the send-invoice chain (public view → email → Stripe self-host pay), the customer-creation chain (inline create → dupe detection → address autocomplete), the full estimates chain (DB + RLS, CRUD/transitions, web pages, convert-to-invoice, public view + send + accept/decline), and audit-history UI (per-entity tab + account-wide /activity feed with collapsible inline diffs) all complete. SaaS multi-tenant payment routing via Stripe Connect deferred to 8.5d / 8.5e; expenses next after.
**Reads:** Assumes you've read PROJECT.md and TECH-STACK.md.

The shape of work between "all decisions locked" and shipping the MVP. Eight foundation phases plus a Phase 8 for the first MVP-feature slices — roughly sequential, each builds on the previous one. Phases 0–7 are the foundation; Phase 8 is where the product becomes visible.

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
| **6** | Mobile app shell (Expo) | Same shape, native shell | ✅ Shipped (slices 6.1–6.4, PRs #70, #71, #73, #74 — 6.2 from #71's commit, the other three each their own PR) |
| **7** | CI/CD and self-host story | Docker compose for self-hosters, GHA for us | ✅ Shipped (slices 7.1–7.4, PRs #76, #77, #79, #80) |
| **8** | MVP features — customers + invoices first, then estimates / expenses / dashboard / AI | This is where the product becomes visible | 🚧 In progress (slices 8.1–8.4f, 8.5a–8.5c, 8.6a–8.6c, 8.7a–8.7e, 8.8a–8.8b, PRs #82–#84, #86, #92, #95, #97–#100, #102–#104, #107, #108, #110, #112–#118 — plus mid-phase footguns #87, #88, #90, #91 and quick-follow fix #96) |

Foundation shipped (Phases 0–7). Phase 8 began with customers + invoices and continues toward the locked MVP scope (PROJECT.md).

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

- **`packages/brand`** — ✅ landed in slice 5.1 (#44) when the SvelteKit shell needed Tailwind tokens; `apps/mobile`'s NativeWind config consumes the same `COLORS` / `FONTS` exports for cross-platform parity.
- **`packages/validation`** — ✅ landed in slice 8.3 (#84) with `customerCreateSchema` + `invoiceCreateSchema` + the `moneyString` / `quantityString` / `isoDateString` primitives; subsequent slices have extended it with `customerUpdateSchema` / `invoiceUpdateSchema` (8.4f) and `invoiceSendSchema` (8.5b).
- **`packages/location`** — ✅ landed in slice 8.6c (#107): `AddressAutocompleteProvider` interface + Mapbox + Nominatim adapters, env-driven factory.
- **`packages/ai`** — still deferred; Vercel AI SDK provider abstraction lands with the first AI feature (cash flow nudge, late payer, anomaly, or receipt extraction — whichever ships first).

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
- **Cookie name renamed `active_company_id` → `active_account_id` (post-8.4a).** The plan called the cookie `active_company_id` on the assumption that a future companies-level picker would slot in without a name change. The value has always carried an `account_id` UUID (memberships are account-level in MVP), and the misnaming kept biting every consumer that touched it. Hard-cut rename — no users in production yet, so no migration path was needed. Same change touched `app.d.ts` (`activeCompanyId` → `activeAccountId`) and the new `apps/web/src/lib/api.server.ts` reader.
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

**Realized (slice numbering):**

| Slice | PR | What landed |
|---|---|---|
| 6.1 | #70 | `apps/mobile/` scaffolded: Expo SDK 56 + React Native 0.85 + react-native-web + Expo Router with `typedRoutes` + `reactCompiler` experiments on. Metro configured for the pnpm monorepo (workspace `watchFolders` per expo.fyi/monorepos). NativeWind 4 wired via `babel-preset-expo` (`jsxImportSource: nativewind`) + `withNativeWind` metro plugin. `tailwind.config.ts` pulls `COLORS` + `FONTS` from `@thalermark/brand` — single source of truth, mirrors the web pattern from slice 5.1. Placeholder home at `src/app/index.tsx` renders `PRODUCT_NAME` + `TAGLINE` to prove the brand→tailwind→nativewind chain end-to-end. Icons under `assets/` are Expo template defaults (placeholders; real brand icons remain a pre-launch concern). No auth, no networking, no tab nav yet. |
| 6.2 | #71 | Better Auth bearer auth + sign-in/sign-up screens + AVD integration fixes. **Server:** `bearer()` plugin registered in `@thalermark/auth` (no-op for cookie clients); `apps/api` CORS gets `Authorization` in `allowHeaders` and `set-auth-token` in `exposeHeaders`. **Mobile:** `expo-secure-store` wrapper at `src/lib/secure-store.ts` (Keychain on iOS, EncryptedSharedPreferences on Android, keyed `thalermark.auth.session-token`). `src/lib/auth-client.ts` uses vanilla `better-auth/client` with `auth: { type: 'Bearer', token: secureStore.get }` plus an `onSuccess` that persists the incoming `set-auth-token`. Sign-in / sign-up screens mirror web's `(auth)` chrome. Home becomes auth-aware via `useFocusEffect` + `getSession()`. **AVD-validation fixes rolled in:** `.npmrc` `public-hoist-pattern` for the Expo/RN ecosystem; direct deps for `@expo/metro-runtime` + `@expo/log-box` in `apps/mobile` (expo-router's entry imports them); dropped `disableHierarchicalLookup` from `metro.config.js` (Expo's guide recommends it but blocks RN's own internals under pnpm); Metro resolver hook retries relative `.js` imports as `.ts`/`.tsx` so `@thalermark/brand`'s NodeNext-style `'./colors.js'` imports resolve under Metro; `Origin: thalermark://` injected into mobile auth-client `fetchOptions` + `thalermark://` added to `TRUSTED_ORIGINS` (RN sends `Sec-Fetch-*` which trips BA's `formCsrfMiddleware` into requiring `Origin`; sign-in slips past it but sign-up doesn't). Validated end-to-end on Android AVD: sign-up, sign-in, force-quit + reopen (token persists), sign-out. |
| 6.3 | #73 | hc<AppType> client + `(app)` tab nav + auth gate. `apps/mobile` gains `@thalermark/api-contract` (workspace) + `hono@4.12.19` direct deps. New `src/lib/api.ts` mirrors web's `apiClient`: `hc<AppType>(baseUrl, { headers: async () => ... })` — dynamic headers fn so each request pulls the live bearer from expo-secure-store; `Origin: thalermark://` pinned for parity with auth-client. `import type { AppType }` (not value import) so Metro doesn't try to bundle `apps/api` at runtime. New `(app)/` route group: `_layout.tsx` uses `useFocusEffect` to fetch session via authClient → loading: spinner, anon: `<Redirect href="/sign-in" />`, authed: mounts `<Tabs>` (single Home screen for now — JIT, real tabs land with features). Home content moved from `app/index.tsx` to `(app)/index.tsx`; root `app/index.tsx` deleted to avoid a URL `/` collision with the group's index. `(auth)` group unchanged — no inverse gate on already-authed users hitting `/sign-in` (acceptable: sign-out is the only path back in MVP). |
| 6.4 | #74 | `(auth)/accept-invite.tsx` mirrors web's slice 5.5: reads `?token=` via `useLocalSearchParams`, `useEffect` calls `authClient.getSession()`, branches no-token / unauthed (Sign in / Create account `<Link>`s carrying `{ pathname, params: { invite: token } }`) / authed (auto-POST via the typed `api.api.invitations[':token'].accept.$post`, then `router.replace('/')`) / error (retry button) / success (transient — the redirect fires within ~100ms). `useRef` guard prevents double-fire of auto-accept on focus refire. `sign-in.tsx` + `sign-up.tsx` read `?invite=` and on success `router.replace({ pathname: '/accept-invite', params: { token: invite } })`; cross-link between the two screens carries the param too. Server side already shipped in 5.5; no API or schema churn. Validated end-to-end on Android emulator: fresh invite for `bob2@test.com` from Alice → deep-link `exp://<lan>:8081/--/accept-invite?token=…` (64 hex chars; first attempt 404'd on a 63-char paste) → unauthed branch renders → Create account → sign-up auto-routes to `/accept-invite` → POST 200 → `router.replace('/')` → home tab signed in as bob2. |

**Realized structure differs from the plan above:**

- **Routes live under `src/app/`, not `app/`.** Expo Router supports both; we kept all source under `src/` to match the SvelteKit and api conventions across the monorepo. `package.json` `"main": "expo-router/entry"` plus `app.json`'s default Expo Router config picks up `src/app/` without extra wiring.
- **`lib/auth.ts` is `lib/auth-client.ts`.** Names the client wrapper distinctly from the server-side `@thalermark/auth` package consumed by `apps/api`, mirroring the same rename made on web in slice 5.3.
- **No standalone `app/_layout.tsx` auth gate.** Auth gating lives in `(app)/_layout.tsx` so the `(auth)` group doesn't pay the session round-trip on every navigation. Root `_layout.tsx` is a bare `<Stack>` that mounts both groups; the gate flips anon→authed when sign-in/sign-up call `router.replace('/')` → resolves to `(app)/index` → `useFocusEffect` refires → reads fresh token from secure-store → renders `<Tabs>`.
- **Tab nav is one screen.** `(app)/_layout.tsx` mounts a `<Tabs>` with only Home for now. Per JIT scaffolding, real tabs (invoices, expenses, etc.) land with the first MVP feature that needs them — not as empty placeholders.
- **Bearer + Origin contract is load-bearing.** Mobile auth-client and api hc client both inject `Origin: thalermark://`; server's `TRUSTED_ORIGINS` must include it. Removing either re-breaks sign-up with `MISSING_OR_NULL_ORIGIN` — asymmetric failure mode (sign-in keeps working) so the regression is easy to miss. The `bearer()` plugin on the server is non-disruptive to web (no-op when no `Authorization` header) — don't gate it behind a flag.
- **Metro + pnpm config (`apps/mobile/metro.config.js` + `.npmrc`) is invariant.** Hierarchical lookup is ON; `public-hoist-pattern` targets the Expo/RN ecosystem. Re-disabling hierarchical lookup or removing the hoist patterns chains back into `UnableToResolveError` whack-a-mole. The `.js`→`.ts`/`.tsx` resolver hook is load-bearing for any workspace package consumed source-first with NodeNext imports.
- **`hc<AppType>` headers must be a dynamic fn, not a static record.** Bearer rotates per-session and is stored async in expo-secure-store — capture-time evaluation would freeze the value. Same goes for any future per-request headers (e.g. `x-account-id` once multi-account picks land on mobile).
- **`import type { AppType }`, not `import { AppType }`.** The latter would force Metro to resolve `@thalermark/api` (and transitively all server deps — drizzle, pg, hono server middleware) at bundle time, which breaks RN. `import type` is erased by the TS transform.
- **Deep-link entry verified via `npx uri-scheme open` on Android emulator.** The custom scheme `thalermark://` is registered in `app.json`, but in Expo Go dev the working dispatch form is `exp://<host>:8081/--/<route>?<query>`. Chrome's address bar ignores `exp://` (treats it as a search query) — use `npx uri-scheme open` or `adb shell am start`. LAN IP works on this emulator; `10.0.2.2` did not. Real scheme-based deep links can't be fully validated until a dev-client or store build exists; not blocking for MVP.
- **Real brand icons remain a pre-launch concern.** `assets/images/*` are Expo template defaults (Expo "E" on iOS system blue, generic Android). Tracked in #70's commit body — replace before any public store submission.

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

**Realized (slice numbering):**

| Slice | PR | What landed |
|---|---|---|
| 7.1 | #76 | `apps/web/Dockerfile` — 4-stage build mirroring `apps/api/Dockerfile` (base → deps → builder → runner). Non-root user, healthcheck probes `/sign-in` (public route — proves SSR is up without coupling web liveness to api). `apps/web/package.json` gains `files: ["build"]` + `start` script (parity with api). Critical side fix: `@thalermark/api` moves from `dependencies` → `devDependencies` in `packages/api-contract` because the re-export is `export type { AppType }` (erased at compile); without this `pnpm deploy --prod` for web drags in api's entire server tree (drizzle, pg, hono server middleware) and fails on `workspace_pkg_not_found`. |
| 7.2 | #77 | `docker/Caddyfile` — same-origin reverse proxy, `/api/*` → `api:3000`, everything else → `web:3000`. Default `THALERMARK_DOMAIN=localhost` → Caddy auto-uses `tls internal` (self-signed via its embedded CA); set to a real hostname → ACME via Let's Encrypt on 80/443. `encode zstd gzip` so static asset responses aren't shipped raw. Validated via `caddy validate`. Compose service block deferred to 7.3 (services need each other to validate end-to-end). |
| 7.3 | #79 | api + web + caddy compose wiring + same-origin routing + a Phase 3.x retrofit folded in. **Wiring:** `docker-compose.yml` uncomments api/web/caddy with env overrides (DATABASE_URL → `postgres:5432`, `MIGRATE_ON_BOOT=true`, `BETTER_AUTH_URL`/`TRUSTED_ORIGINS`/`PUBLIC_APP_URL` use `${THALERMARK_DOMAIN:-localhost}`); `caddy_data`/`caddy_config` volumes persist certs across restarts; `env_file: ../.env` pulls secrets from the project-root `.env`. **Same-origin URL split:** `apps/web/src/hooks.server.ts` reads a new server-only `INTERNAL_API_URL` via `$env/dynamic/private`, falls back to `PUBLIC_API_URL`. Browser uses relative `/api/*` (PUBLIC_API_URL=""), SSR uses `http://api:3000` (compose hostname). **Retrofit:** `packages/db` + `packages/auth` + `packages/telemetry` each get `tsconfig.build.json`, `main → dist/index.js`, `files: ["dist", ...]`, and a `build` script — mirroring the existing `@thalermark/logger` pattern. The api Dockerfile from 3.1 anticipated this (`pnpm --filter=...build` per dep) but 3.3/3.4/3.6 missed adding the lines, so workspace deps shipped as `.ts` in `node_modules` and Node 24's `--experimental-strip-types` refused to load them. Caddyfile drops the global `email` directive — Caddy's `${VAR:default}` substitution does NOT fall back when the env var is set to empty string, and compose was passing `ACME_EMAIL=""` through. ACME issuance works without a registered email; operators wanting renewal alerts add a global email block. **Validated:** fresh `docker compose up` brings the stack up; `curl -k https://localhost/sign-in` → 200, `POST /api/auth/sign-up/email` creates user + the BA hook seeds account+membership, `GET /api/me` round-trips through Caddy with the `__Secure-better-auth.session_token` cookie (`Secure`+`HttpOnly`, inferred from `BETTER_AUTH_URL=https://localhost` even though Caddy → api is plain HTTP). |
| 7.4 | #80 | `docker-build` CI job — runs `docker compose -f docker/docker-compose.yml build api web` on every PR with Buildx + a staged `.env.example → .env` copy (compose validates the `env_file:` path at build time). Would have caught the 3.x Dockerfile drift fixed in 7.3 three slices earlier. README gains a Self-host section pointing operators at the same flow that validated 7.3 — `cp .env.example .env`, replace `BETTER_AUTH_SECRET`, `docker compose up`, hit `https://localhost`. Real-domain path notes the `THALERMARK_DOMAIN` knob and 80/443 reachability requirement. No CLA wiring — CLA Assistant is already installed at the GitHub org level per Phase 0 production-readiness. |

**Realized structure differs from the plan above:**

- **CI's test job did not gain a Postgres service container.** Testcontainers (wired in 1.2b) already spins up postgres-per-test-file via Docker socket access; layering a GHA service container on top would duplicate the same image pull without making any test faster. The new `docker-build` job is the only CI structure change Phase 7 adds.
- **The api Dockerfile build chain expanded to four lines (logger, db, auth, telemetry), not "one new line per dep added in the future."** The 3.1 comment ("the list grows as upstream slices bring more packages…") implied a single-line append per phase, but 3.3/3.4/3.6 never appended. 7.3 paid the full retrofit in one go, mirroring `@thalermark/logger`'s `tsconfig.build.json` + `files: ["dist"]` pattern across all three packages. Future workspace deps that apps/api consumes at runtime must follow the same recipe and add their `pnpm --filter=...build` line.
- **Same-origin URL split required a code change in `apps/web/src/hooks.server.ts`, not just compose env vars.** SvelteKit's `$env/dynamic/public` returns the same value to both SSR and browser; same-origin from the browser requires relative URLs, but SSR `fetch` needs an absolute URL. The fix splits the read across `$env/dynamic/private` (server-only `INTERNAL_API_URL`) and `$env/dynamic/public` (browser `PUBLIC_API_URL`, empty in self-host). `||` not `??` so an explicit empty string falls through to the dev fallback.
- **`@thalermark/api` flipped from `dependencies` → `devDependencies` of `@thalermark/api-contract`.** The re-export is `export type { AppType }` — type-only, erased at compile. With it as a runtime dep, `pnpm deploy --prod /out` for web pulled the entire api server tree (drizzle, pg, hono server middleware) into the web runtime image and failed on `workspace_pkg_not_found`. Local typecheck still resolves the chain because pnpm dev installs transitive devDeps.
- **Caddy global `email` directive dropped.** `${VAR:default}` substitution does not fall back when the env var is set to empty string, and compose's `${ACME_EMAIL:-}` interpolation passes empty when the var is unset in `.env`. ACME issuance works without a registered email (anonymous account); a real registered email can be added back as a global block when operators want renewal alerts. `ACME_EMAIL` is no longer wired through compose or `.env.example`.
- **`docker compose -f docker/docker-compose.yml` is the canonical invocation.** Compose discovers files in cwd by default, but the file lives in `docker/`. The README, CI job, and validation runs all use the explicit `-f docker/docker-compose.yml` flag from the repo root so operators don't have to `cd docker` first.

---

## Phase 8 — MVP features begin (customers + invoices)

The first MVP-feature slice. Customers + invoices land together because customers must exist before an invoice can name one. DB → API → web read → web write, in that order, so each layer ships against a real upstream. Estimates / recurring invoices / public view / expenses / dashboard / AI follow in later 8.x slices; mobile catches up after the web flow is feature-complete.

Phase 8 has no pre-phase plan block in this doc — slices are scoped JIT off PROJECT.md's locked MVP list, and SCAFFOLDING.md picks up tracking once each slice merges.

**Validation:** Sign up → land on an empty home → `/customers` lists the auto-seeded company's customers (initially none) → `/customers/new` creates one → `/invoices` lists invoices and `/invoices/[id]` shows header + line items. End-to-end exercises BA cookie → web SSR `hc<AppType>` client → `x-account-id` → API tenant tx → RLS-fenced rows.

**Realized (slice numbering):**

| Slice | PR | What landed |
|---|---|---|
| 8.1 | #82 | `customers` table (migration 0016) + RLS (0017) — first MVP-feature table. Standard tenant-isolation policy via the NULLIF idiom. `account_id` carried for RLS uniformity, `company_id` FK NOT NULL, flat address columns (Mapbox / Nominatim autocomplete will write structured response straight into them — JSONB would need an unwrap on every render). Email / phone / notes optional; tax-id and exemption deliberately absent because compliance is a pluggable module, not a column set. App role gets full CRUD within tenant; `staff_readonly` stays SELECT-only. |
| 8.2 | #83 | `invoices` + `invoice_line_items` tables (migrations 0018 / 0019) with the same tenant-isolation policy. Money columns are `numeric(15,2)` (returned as decimal strings — exact-precision math in Postgres, multi-currency option open). `issue_date` / `due_date` are bare dates (no TZ — keeps "due on the 15th" out of the timezone rabbit hole). `customer_id` is `ON DELETE RESTRICT` so customers with invoices can't be hard-deleted. `(company_id, number)` unique within an account; the same number is allowed across companies on one account. Line items denormalize `account_id` for RLS uniformity with the rest of the schema — one redundant column saves one subquery on every read. Status transitions, `sent_at` / `paid_at` / `voided_at`, and the public-view token defer to the slice that actually transitions status. |
| 8.3 | #84 | First MVP-feature API slice. JIT-spawns `@thalermark/validation` (zod, ships as JS per Phase 7.3 invariant) with the first shared schemas: `customerCreateSchema`, `invoiceCreateSchema`, `invoiceLineItemInputSchema` + `moneyString` / `quantityString` / `isoDateString` primitives. Routes (all account-scoped via slice 3.5 `rls-context`): `GET /api/companies`, `POST` / `GET /api/customers` + `/api/customers/:id`, `POST` / `GET /api/invoices` + `/api/invoices/:id`. Invoice POST writes header + line items in the existing tenant tx; pre-checks the `(company_id, number)` unique constraint so a duplicate returns a clean 409 instead of poisoning the tx (a constraint throw would roll back the audit row written ahead of the business writes). Customer↔company mismatch → 400; cross-tenant IDs → 404 under RLS. Every SELECT carries an explicit `eq(table.accountId, accountId)` filter — defense in depth ahead of the role swap in #88. Signup hook now seeds a default `companies` row alongside accounts + memberships in one tx; without it new users had no `companyId` to invoice against and the flow was production-unreachable. |
| 8.4a | #86 | First web round-trip against Phase 8 data. Read-only list + detail pages for customers and invoices, wired through a new server-side `hc<AppType>` client at `apps/web/src/lib/api.server.ts` that forwards the BA cookie and stamps `x-account-id` from `locals.activeAccountId` (post-#87 rename). Money rendered as the API returns it (decimal strings, no `Number()` coercion — silent precision-loss risk). Nav links added to the `(app)` header. List omits `companyId` query param — single-company MVP users get all rows in their account, which is the one company. |
| 8.4b | #92 | Customer create form. New `/customers/new` route with a SvelteKit server action that posts to `POST /api/customers`. Reuses `customerCreateSchema` from `@thalermark/validation` for server-side parse + per-field error rendering. Form posts plain HTML (no `use:enhance`) so it works without JS, in line with the mobile-first / slow-network thesis — the redirect → detail page is one full nav, no spinner, no flash. Auto-picks the only company for single-company MVP users; multi-company picker deferred. List page gains a `+ New customer` header CTA. Web pulls in `@thalermark/validation` as a workspace dep; Dockerfile builds that package before the web build so Vite can resolve `dist/index.js` (the ship-as-JS invariant from slice 7.3 now applies to web-runtime deps, not just api). |
| 8.4c | #95 (+ quick-follow #96) | Invoice create form. New `/invoices/new` with a server action that posts to `POST /api/invoices`. Heaviest piece of Phase 8 because of line items: variable-length array, per-row delete, money formatting + live preview, plus 409 recovery on `(company_id, number)` collision. Live preview mirrors the server's compute path (`addMoney` / `multiplyMoney` / `sumMoney` from `packages/validation`) so the form works without JS and with JS the preview can't drift from what's stored. Server-side recompute on POST is authoritative — the schema validates each money/quantity field shape but does not re-derive (locked by [[architecture_money_decimal_strings]]). #96 quick-follow fixed the SSR re-render path: `tax` and the rows `$state` initializers now read `form?.values` via `untrack()` so the values restore on every fail()-rendered submit without the `state_referenced_locally` warning — needed because the no-JS path gets a fresh SSR per POST. List + detail pages gain `+ New invoice` and `← Invoices` nav glue. |
| 8.4d | #97 | Smart invoice-numbering helper. New `GET /api/invoices/next-number?companyId=<uuid>` returns `{ suggestion }` by pulling the company's most recent invoice (createdAt desc) and incrementing the trailing integer of its number while preserving prefix and zero-padding (`INV-0042` → `INV-0043`, `2026-007` → `2026-008`, `42` → `43`). No prior invoice or no trailing integer falls back to the locked first-invoice default `INV-0001`. Route declared **before** `/api/invoices/:id` — Hono is first-match, and the path-param route would otherwise capture `next-number` and 400 on the UUID regex. Account-scoped via standard `rls-context`. Web `/invoices/new` load fetches the suggestion alongside companies and customers; the number input reads `value={values?.number ?? data.suggestedNumber}` so the 8.4c fail-re-render restore still wins over the suggestion (important for 409 recovery — the colliding number must stay editable, not be silently replaced). Suggestion fetch is best-effort: a transient API failure leaves the field empty, doesn't block the page. Single source of truth in the API so mobile can hit the same endpoint when it catches up. |
| 8.4e | #98 | Invoice status transitions. Migration 0020 adds `sent_at` / `paid_at` / `voided_at` (timestamptz, nullable, write-once stamps). Three action-style POST endpoints — `/api/invoices/:id/mark-sent`, `/mark-paid`, `/void` — share an `INVOICE_TRANSITIONS` table + `transitionInvoice` helper in `apps/api/src/app.ts` so a future `unvoid` / `unpay` / partial-paid is a one-line addition there, not a fresh endpoint pattern. State machine: `draft → sent`, `draft | sent → paid`, `draft | sent → voided`; `paid` and `voided` are terminal in MVP. `mark-paid` from `draft` deliberately skips `sent_at` (don't lie about a send that never happened); from `sent` leaves the prior `sent_at` intact. Invalid transitions return 409 with `{ error: invalid_transition, from, to }`. Each transition writes one audit row with the full status + stamps diff — exercises the audit path on UPDATE (creates already covered it). Web invoice detail page renders status-appropriate Mark sent / Mark paid / Void buttons via named SvelteKit form actions (`?/markSent`, `?/markPaid`, `?/void`); terminal states hide the buttons so the UI doesn't tempt a 409 round-trip. |
| 8.4f | #99 | Customer + invoice edit. `customerUpdateSchema` and `invoiceUpdateSchema` derive via `.omit({ companyId: true })` — companyId is intentionally immutable on both (a customer cannot move between companies because their invoices are scoped to the original company; an invoice cannot move because the `(company_id, number)` uniqueness + customer↔company invariants would break). `customerId` on invoice stays mutable so a draft can be reassigned within the same company. PATCH `/api/customers/:id` is full-replacement (undefined optionals collapse to null in the DB — clearing a field is a first-class operation, not "unchanged"). PATCH `/api/invoices/:id` is draft-only (409 `not_editable` on sent/paid/voided — once out the door, mutating silently misdirects the audit trail and the counterparty's record); line items replaced wholesale in the same tenant tx (select old → delete → insert new → update header). Both PATCHes adopt `hono/validator('json', ...)` middleware — needed because path-param routes type Input as `{ param }` and TS's excess-property check rejects `{ param, json }` when the handler uses bare `c.req.json()`. validator lifts the body into the typed Input so `hc<AppType>()` accepts `{ param, json }` and lets the handler drop the duplicated safeParse via `c.req.valid('json')`. Existing POSTs (no path param → `BlankInput` accepts excess properties) keep working unchanged. Web `/customers/[id]/edit` and `/invoices/[id]/edit` reuse the create-form layouts prefilled; invoice edit route is status-gated at `load()` (409 if not draft) so a stale tab gets a clean error instead of a confusing post-submit 409. |

**Slice 8.5 — send-invoice chain (self-host complete; SaaS Connect pending in 8.5d / 8.5e):**

| Slice | PR | What landed |
|---|---|---|
| 8.5a | #100 | Public invoice view — the unauthed page the recipient lands on. Migration 0021 adds `public_token` (text, nullable, unique-indexed) to invoices. `transitionInvoice` mints 32 random bytes hex (same pattern as the invitation token — large enough that brute-force enumeration is uneconomical even without rate limiting) on `mark-sent` when the row has none; other transitions leave it alone. Idempotent so a future re-send keeps the URL stable. Status-transition audit row now carries `publicToken` in before/after alongside the existing status + stamps. `rls-context` middleware gained `PUBLIC_PATH_PATTERNS` (currently `/^\/api\/public\//`) that early-returns `next()` *before* the session check — no auth, no tenant. `GET /api/public/invoices/:token` reads via `bootstrapDb` (RLS would hide everything under the missing `app.current_account_id` setting — the bootstrap-reads watch since #90/#91) and returns customer-facing fields only (header, line items, customer name, sender company name, status, stamps, totals) — account_id / company_id / customer_id / audit trail stay out of the response. Web mirror: `hooks.server.ts` gained a `PUBLIC_PREFIXES` list (currently `['/i/']`) that bypasses the auth redirect, and the new `/i/[token]` route lives outside the `(app)` and `(auth)` groups so it only inherits the root layout (no app chrome on what the recipient sees). Uses a direct `event.fetch` not the typed `api.server` client so no cookie / x-account-id leaks from a stray hydration. Invoice detail page surfaces the absolute share URL once the token exists, built off `event.url.origin` so it works behind any proxy without an extra env var; copy/paste pending the 8.5b email-send slice. |
| 8.5b | #102 | Email transport. New `POST /api/invoices/:id/send` transitions `draft → sent` and emails the recipient with the public-view URL, or resends without transitioning when already `sent`. Mailer is an inline two-driver abstraction (Resend over fetch, console fallback for dev / self-host without `RESEND_API_KEY`); SMTP defers to a future slice when the first self-host operator needs it. Email I/O runs **outside** the audit tx so a Resend 5xx surfaces as 502 with the status flip already committed — a failed send must not silently roll back `mark-sent` and leave the audit trail lying about what happened. Web detail page promotes "Send invoice" as the primary CTA with a collapsible to-override field; "Mark sent without email" stays available for the out-of-band case. Success banner survives the post/redirect via `?sent=<address>` in the URL. `invoiceSendSchema` added to `@thalermark/validation` so `hc<AppType>()` clients get typed access to the optional body. |
| 8.5c | #108 | Self-host pay link — recipient hits Pay on `/i/[token]`, Stripe Embedded Checkout mounts inline, webhook fires and marks the invoice paid. **Scope deliberately self-host only:** a single `STRIPE_SECRET_KEY` routes all payments to whoever owns that key — correct for self-hosted freelancers (they're their own merchant), wrong for SaaS where a tenant's customer would otherwise pay Thalermark instead of the tenant. SaaS multi-tenant routing needs Stripe Connect (connected accounts + onboarding + `stripeAccount` header on session mint) and lands in 8.5d (onboarding) + 8.5e (connected payments); the flow built here doesn't change — Connect adds one parameter to checkout-session creation and an onboarding gate, the Embedded Checkout / webhook / idempotency / audit machinery all carry over. New `apps/api/src/lib/stripe.ts` wraps the SDK with `createStripeBundle` returning `null` when any of the three `STRIPE_*` env vars is missing — Stripe-disabled is a first-class state (Pay button hidden, webhook 503s, rest of the app runs). `decimalDollarsToCents` converts our money strings to Stripe integer minor units without floating-point loss (`"0.10" → 10`), preserving [[architecture_money_decimal_strings]] end-to-end. Two new public routes via a fresh `/api/webhooks/*` public-prefix (joins `/api/public/*` in `PUBLIC_PATH_PATTERNS`, leaves room for future provider webhooks): `POST /api/public/invoices/:token/checkout-session` lazy-mints an Embedded Checkout session (`ui_mode: 'embedded_page'`, `currency=usd`, `client_reference_id=invoice.id`) only when the recipient clicks Pay — no Stripe API calls on passive page loads — and is status-guarded to `sent`; `POST /api/webhooks/stripe` verifies the signature against the raw body, filters to `checkout.session.completed` + `payment_status=paid`, and runs `mark-paid` on `bootstrapDb` (no tenant context; the signature **is** the auth). Audit attributed to the synthetic system user from migration 0009 (`auth_user.is_system` — schema explicitly anticipated this for provider callbacks). Idempotent: re-delivered events find `status === 'paid'` and 200 without writing. Web wires the existing `/i/[token]` page via a new `payable` flag the API returns; a SK action proxies the session-mint POST (cross-origin from browser to api is blocked, SK proxy is the established public-page pattern); `@stripe/stripe-js` is lazy-imported on Pay-click so recipients who never pay don't ship ~100kb of Stripe.js. After payment Stripe navigates back to `/i/[token]?paid=1` — in the common case the webhook has already committed and the page renders the Paid banner; if still in flight, a "Payment received, finalizing" banner shows until refresh. Local-dev path documented in `.env.example`: `stripe listen` prints a `whsec_…` for `STRIPE_WEBHOOK_SECRET`, then `stripe trigger` exercises the path end-to-end. |

**Follow-up #110 — invitations cut over to the Mailer abstraction.** `POST /api/invitations` now sends a real email through the `Mailer` interface introduced in 8.5b instead of logging the accept URL via the `logInviteUrl` test seam. With Resend + console drivers already in place, the parallel "log the URL" path was dead-end duplication. Dev / self-host without `RESEND_API_KEY` still gets the invite URL in api stdout, formatted as a structured `[email] from=... to=... subject=...` log line rather than the previous one-liner. Failure mode mirrors 8.5b's `/send`: a mailer 5xx surfaces as 502 after the invitations row has already committed in the tenant tx, because rolling back would silently discard an invitation the caller saw acknowledged. `AppDeps` loses the `logInviteUrl` test seam — every caller that injected `() => {}` (customers + invoices test files) drops the line, and the invitations test swaps to the recorder-mailer pattern that `invoices.integration.test.ts` already established for the `/send` tests.

**Slice 8.6 — customer-creation chain:**

| Slice | PR | What landed |
|---|---|---|
| 8.6a | #103 | Inline customer create on `/invoices/new`. The "+ Add new customer" sentinel in the customer dropdown opens a name + email block inline; submitting POSTs `/api/customers` first, then uses the returned id for the invoice POST in the same action. Zero-customers state opens straight into inline mode instead of bouncing to `/customers/new`. 409 recovery: if the customer creates but the invoice POST fails (e.g. number taken), the just-created customer comes back in `form.extraCustomer` and pre-selects in the dropdown — fixing the invoice number and resubmitting attaches it to the same customer instead of silently creating a duplicate. Web-only slice; reuses `customerCreateSchema` from `@thalermark/validation` and the existing `POST /api/customers` endpoint. Phone / address / notes inline fields stayed out of scope so the inline block stays minimal; dupe detection + Mapbox autocomplete split into 8.6b / 8.6c. |
| 8.6b | #104 | Customer dupe detection. New `apps/web/src/lib/customer-dupes.ts` exposes `findEmailDupe` (exact case-insensitive trimmed equality) and `findNameDupes` (normalize lowercase + collapse whitespace + strip non-alphanumeric, then equal). Pure functions matched client-side against the already-loaded customer list — no extra fetch, no new API surface. Email match is the strong signal: live banner as the user types, AND a server-side hard block at submit time that returns the existing customer in `form.dupeCustomer`. On `/invoices/new` the block offers "Use {name} instead" which swaps the dropdown to the existing customer; on `/customers/new` it opens the existing customer's detail page. Name match is advisory — live suggestion list with Use / Open actions, no submit block. `/customers/new` gains a `load()` to fetch the customer list (was previously write-only); both forms re-fetch the list inside the action before the dupe check to close the race where another tab created a dupe between page load and submit. Gmail-dot / +tag email normalization and Levenshtein / trigram name matching deferred — JIT until users hit them. Edit-time dupe check and phone matching out of scope. |
| 8.6c | #107 | Closes the customer-form chain. JIT-spawns `@thalermark/location` with the portable `AddressAutocompleteProvider` interface locked in TECH-STACK.md — Mapbox by default, Nominatim self-host fallback. Factory auto-picks Mapbox when `MAPBOX_ACCESS_TOKEN` is set and Nominatim otherwise, so dev "just works" and prod is a one-env-var toggle. Misconfig and upstream failures both degrade to empty suggestions + a "fill in by hand" hint rather than 500ing the form. Package ships compiled JS to `dist/` per the slice 7.3 api-runtime invariant; web Dockerfile builds it before the Vite step (same recipe as `@thalermark/validation`). New same-origin SK proxy at `/locations/autocomplete`, auth-gated by `hooks.server.ts` — lives on web rather than the Hono api because Caddy routes `/api/*` away from web in prod and the api has no browser-facing CORS surface today; mobile can move it to api later when it needs the same endpoint. `AddressLookup.svelte` is a combobox with debounce, in-flight abort, keyboard nav, and a mousedown-pick that survives input blur. A pick writes `addressLine1` / `city` / `region` / `postalCode` / `country` into the parent's `$bindable` state in one go; underlying fields stay editable so the user can correct anything the provider got wrong. Without JS the lookup is invisible and the form submits as plain inputs. Wired into `/customers/new` and `/customers/[id]/edit`; the inline-create block on `/invoices/new` only collects name + email, so no autocomplete there. The fail-re-render seeding pattern from 8.4c carries over — `$state` initializers read `form?.values` via `untrack()` so a 4xx bounce keeps the typed-but-not-submitted input. |

**Slice 8.7 — estimates chain:**

| Slice | PR | What landed |
|---|---|---|
| 8.7a | #112 | `estimates` + `estimate_line_items` tables (migration 0022) + RLS (0023). Mirrors the invoice schema with three deltas: nullable `expires_on` date (advisory-at-read — no background sweep until pg-boss lands), accept/decline/expired write-once stamps replacing paid/voided, and `converted_invoice_id` FK → invoices ON DELETE SET NULL so deleting an invoice doesn't cascade through the estimate's history. Standard NULLIF tenant-isolation RLS on both tables. `(company_id, number)` uniqueness is per-table so INV-001 and EST-001 can coexist on one company. |
| 8.7b | #113 | Estimates CRUD + status transitions API. 8 routes (POST/GET list, GET next-number BEFORE `:id` per the first-match ordering, GET single, PATCH draft-only, mark-sent/mark-accepted/mark-declined transitions). `mark-sent` mints the same 32-byte hex `public_token` as invoices. State machine: `draft → sent`, `draft | sent → accepted`, `draft | sent → declined` — operator can capture a verbal close from draft without going through send. `accepted` and `declined` are operationally terminal in MVP (convert-to-invoice is a link action in 8.7d, not a status flip). The invoice `suggestNextInvoiceNumber` helper refactored to share a tiny private `nextNumberWithDefault` with the new `suggestNextEstimateNumber` (`EST-0001` default). `@thalermark/validation` gains `estimate{Create,Update,LineItemInput}` schemas. |
| 8.7c | #114 | Estimates web pages. `/estimates` list with status + expires column, `/estimates/[id]` detail with status-aware mark-sent / mark-accepted / mark-declined buttons + advisory expiry banner when sent and `expires_on < today` + share URL pointing at `/e/[token]` (unauthed public route lands in 8.7e), `/estimates/new` with line-item live preview + suggested number + optional `expires_on` (default today + 30), `/estimates/[id]/edit` status-gated to draft at `load()`. Pattern mirrors invoice routes 8.4a–f compressed. Nav header gains an Estimates link. **Inline customer-create deliberately skipped** for this slice — the trades-on-doorstep use case is real but the sentinel/dupe-detect flow from 8.6a–b stays a follow-on slice rather than gold-plating 8.7c; `/customers/new` is one nav step away. |
| 8.7d | #115 | Convert estimate to invoice. New `POST /api/estimates/:id/convert` mints a draft invoice from an `accepted` estimate in one tenant tx — copies header + line items, auto-numbers via the existing `suggestNextInvoiceNumber` pipeline, sets `estimates.converted_invoice_id` (the FK landed in 8.7a), and writes both `convert` (estimate) + `create` (invoice) audit rows. **Idempotent:** a second call returns the existing invoice id with 200 (no duplicate). Gated to `status=accepted` (draft / sent / declined → 409 `invalid_transition`). Defaults: `issueDate=today`, `dueDate=today+30d` — operator edits before sending. Estimate status does **not** flip — convert is a link action, not a status transition. Web: estimate detail page gains "Convert to invoice" CTA when accepted + unconverted; "Converted to invoice →" link once linked. |
| 8.7e | #116 | Public estimate view + send + customer-side accept/decline. Mirrors 8.5a + 8.5b for estimates, plus new public accept/decline. `POST /api/estimates/:id/send` does `draft → sent` (stamps `sent_at`, mints `public_token`) + emails the recipient with the `/e/<token>` link; resend on sent emails only without re-minting. Mailer 5xx surfaces 502 but the status flip already committed (same trade-off as invoice `/send`). 409 from accepted / declined / expired. `GET /api/public/estimates/:token` bootstrap-reads customer-facing fields only + a `canRespond` flag (status='sent'). `POST /api/public/estimates/:token/{accept,decline}` transition sent → accepted/declined on `bootstrapDb` and write `public-accept` / `public-decline` audit rows attributed to `SYSTEM_USER_ID` (same pattern as Stripe webhook; `rls-context` bypassed via the existing `/^\/api\/public\//` `PUBLIC_PATH_PATTERNS`). Web: `hooks.server.ts` `PUBLIC_PREFIXES += '/e/'`; new `/e/[token]` route outside `(app)`/`(auth)` groups with Accept/Decline form actions; estimate detail page promotes "Send estimate" as primary CTA with optional `to` override, "Mark sent without email" demoted to secondary link. New `estimateSendSchema` in `@thalermark/validation`. |

**Slice 8.8 — audit history UI:**

| Slice | PR | What landed |
|---|---|---|
| 8.8a | #117 | Per-entity audit history tab. New tenant `GET /api/audit-events?entityType=...&entityId=...` reads `audit_events` filtered by `(entityType, entityId)` (uses the existing entity index), joined with `auth_user` to resolve `actor_user_id` → display name. The synthetic system user (`is_system=true`, migration 0009) renders as "System" so provider-driven rows (`stripe-paid`, `public-accept`, `public-decline`) are attributed without leaking the system uuid. `actorUserId` itself is dropped from the response shape. Validation gates entityType ∈ {customer, invoice, estimate}; entityId UUID. New `apps/web/src/lib/components/AuditHistory.svelte` renders compact rows ("<actor> <action verb> · <relative time>") with action verbs mapped via a small dict (unmapped actions show the raw label as fallback — future actions appear in the UI without a code change). Wired into customer/invoice/estimate detail pages — each `load()` best-effort fetches the trail (non-OK renders empty rather than failing the whole page); component rendered at the bottom of each detail page. |
| 8.8b | #118 | Account-wide activity feed + inline collapsible diff. `GET /api/audit-events` extended to serve two modes off the same surface — per-entity (8.8a shape) and feed (both query params omitted, account-wide). New `limit` query (default 50, max clamped 200; zero / negative / non-numeric → 400). Validation rule: entityId requires entityType. Feed mode enriches each row with `entityLabel` (invoice/estimate `number`, customer `name`) via one `inArray` lookup per entity type — 3 small queries, not N+1 — so the feed UI renders "Invoice INV-0042" without per-row resolution. `AuditHistory.svelte` replaced raw JSON `<details>` with computed field deltas ("status: draft → sent", "total: 100.00 → 120.00") hidden by default behind a muted "N change(s)" `<details>` toggle so both views stay visually tight. Diff utility skips line-item arrays (noise; the entity page shows them) and `*At: ∅ → <ts>` (already implied by transition labels); 24-char truncation on long strings keeps tokens/uuids readable. New `showEntity` prop renders an "Invoice INV-0042 — …" link prefix used by the feed view. New `/(app)/activity` route with server load + svelte page reusing `AuditHistory(showEntity)`; nav header gains "Activity" alongside Invoices/Estimates/Customers. |

**Slice L — ledger reshape (hidden double-entry):**

Sequenced before the expenses chain because expenses must be built ledger-aware from day one — retrofitting after expenses ships is meaningfully more expensive than retrofitting invoices + estimates (which carry no production data today). User-facing UI does not change; this is purely a data-model commitment. See PROJECT.md "How the books work" for the why.

| Slice | PR | What landed |
|---|---|---|
| L1 | (pending) | Ledger foundation. New `chart_of_accounts` + `journal_entries` + `journal_lines` tables (migration 0025) and `companies.business_type` column; hand-written 0026 adds NULLIF tenant-isolation RLS + CHECK constraints (account_type, normal_balance, side, amount > 0) + a DEFERRABLE constraint trigger on `journal_lines` enforcing per-entry sum-to-zero + min-2-lines invariants at commit. `chart_of_accounts` is full-CRUD within tenant; `journal_entries` + `journal_lines` are append-only (SELECT + INSERT policies only, mistakes corrected via reversing entry). Sole-prop COA seed (`packages/db/src/seed/coa-sole-prop.ts`) — 26 accounts (4-digit codes: 1000s assets, 2000s liabilities, 3000s equity, 4000s revenue, 6000s+ expenses ordered to match Schedule C Part II line order) with Schedule C line numbers in a `tax_mapping` column. Depreciation deliberately omitted (needs the fixed-asset / accumulated-depreciation workflow that lands later); COGS deliberately omitted (service-led trades treat materials as Supplies per the Wave default). Signup hook seeds the COA for the default company alongside account + company + membership in the same tx. Posting helper not written yet — that's L2. |
| L2 | — | Wire posting rules into invoice + estimate state transitions. `transitionInvoice` mark-sent posts AR↔Revenue (+ Sales Tax Payable if `tax > 0`); mark-paid posts Cash↔AR; void posts the reversal of whatever was already posted. Stripe-webhook mark-paid runs through the same posting helper on `bootstrapDb` (still attributed to SYSTEM_USER_ID). Estimates remain informational (no postings) for symmetry. Tests: every transition produces a balanced entry; trial balance for a tenant sums to zero on every fixture. |
| L3 | — | Business-type wizard at company creation. Surfaces the `business_type` enum (sole prop / LLC / partnership / S-corp / C-corp) in the existing signup hook + a new explicit company-create flow. MVP still seeds the sole-prop COA regardless of pick (per the locked decision); the column captures the operator's real answer for the v1.x switch. |
| L4 | — | Optional GL / trial-balance export endpoint. Tenant-scoped `GET /api/companies/:id/ledger/export` returns a balanced GL (CSV or JSON) over a date range. Can fold into the accountant-handoff slice later. |

**Mid-phase footguns surfaced and fixed:**

- **#87 — `active_company_id` → `active_account_id` cookie rename.** The cookie name from slice 5.4 implied a future company-level picker, but the value has always carried an `account_id` UUID (memberships are account-level in MVP) and the misnaming kept biting every consumer that touched it. Hard-cut rename — no production users, no migration needed. Touched `hooks.server.ts`, `app.d.ts`, the `select-company` action, and the new `api.server.ts` reader. The Phase 5 §5.4 deltas note now reflects the renamed name.
- **#88 — api connects as `thalermark_app`, not the superuser.** Production runtime now uses the non-BYPASSRLS `thalermark_app` role (created back in migration 0005) so RLS policies actually fire as the primary tenancy fence rather than as quiet defense-in-depth behind a superuser pool. Two connection strings: `DATABASE_URL` (superuser, DDL only — migrations + boot-time role provisioning); `APP_DATABASE_URL` (runtime, `thalermark_app`). When `THALERMARK_APP_PASSWORD` is set, `server.ts` runs `ALTER ROLE thalermark_app WITH LOGIN PASSWORD <env>` at boot — idempotent, so rotation is a redeploy; operators with out-of-band role provisioning leave the password empty. Self-host compose threads both env vars in with sensible defaults so out-of-box `docker compose up` keeps working. Integration tests stay on the testcontainer-superuser pattern; promoting them is a worthwhile follow-up. **Self-host operators with an existing `.env` must add `THALERMARK_APP_PASSWORD` on next pull** (or accept the `thalermark_app` default).
- **#90 + #91 — bootstrap reads under `thalermark_app`.** #88 swapped the runtime pool but left `/api/me` and `rls-context`'s pre-tx membership probe on the tenant handle. Both run before `x-account-id`, and the accounts / memberships RLS policies gate visibility on `app.current_account_id` (unset on bootstrap), so every authed request to a tenant route 403'd and `/api/me` reported zero memberships even when rows existed — the sign-up hook was correctly creating account + company + membership, but the bootstrap reads couldn't see them, so the web shell bounced every new user to `/select-company`'s "not set up" screen. #90 added an optional `bootstrapDb` on `AppDeps` + `RlsContextDeps` (defaults to `db` for the testcontainer-superuser tests) and routed the two reads through it. #90 was incomplete — it shipped without the `apps/api/src/server.ts` hunk that constructs the second pool and passes it in, so `bootstrapDb` fell back to `db` and the bug stayed live on main. #91 added that hunk and renamed `authDbHandle` → `bootstrapDbHandle` since it now serves more than BA. **Watch this pattern** — any future API surface that reads before tenant context (a future `/api/me/*` route, an unauthed public-invoice fetch) must go through `bootstrapDb`, not `db`, or it will silently return zero rows under RLS.

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
