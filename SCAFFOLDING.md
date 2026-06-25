# Scaffolding Plan

**Status:** Phases 0–8 shipped; **Phase 9 (mobile catch-up) COMPLETE (2026-06-09)** — the RN/Expo app now mirrors every web MVP flow (slices M1–M11f, PRs #174–#190). Phase 8 (MVP features) slices 8.1–8.4f, 8.5a–8.5e, 8.6a–8.6c, 8.7a–8.7e, 8.8a–8.8b, L1–L4, 8.9a–8.9h, 8.10–8.15, R1–R4, I1–I5 merged (latest 2026-06-07). Invoice CRUD + status flow, the send-invoice chain (public view → email → Stripe self-host pay → SaaS Stripe Connect onboarding + connected payments), the customer-creation chain (inline create → dupe detection → address autocomplete), the full estimates chain (DB + RLS, CRUD/transitions, web pages, convert-to-invoice, public view + send + accept/decline), audit-history UI (per-entity tab + account-wide /activity feed with collapsible inline diffs), the hidden-double-entry ledger reshape (foundation + invoice-transition postings + business-type wizard + GL / trial-balance export), and the full expenses chain (DB + RLS → ledger posting policy → CRUD API → web list/create/detail/edit → object-storage package → receipt capture → vision-LLM receipt extraction) all complete; plus the position dashboard, the full AI insight layer (5 insights: receipt extraction, expense categorization, cash-flow nudges, late-payer detection, spending anomalies), duplicate-as-template across invoices/estimates/expenses, and the recurring-invoice chain (schema → CRUD → pg-boss generation engine + sweeper → web UI — the first pg-boss consumer); plus the items / products & services catalog (Slice I, scoped 2026-06-07 — table + provenance FK → CRUD API → management surface → line-item autocomplete → top-products report). The full locked MVP web scope is feature-complete, and the **mobile catch-up is now complete too (Phase 9)** — every web MVP flow has a native equivalent. **Remaining MVP product work is polish + ship.** **Post-MVP web polish (not slice-tracked here):** keyset pagination across the lists, the report lineup grown to 9, and **#237** — client-side CSV export on every report page + the GL/ledger export finally surfaced in the UI (detail on the **L4** row). **Pre-launch email overhaul (slice-tracked below):** the customer-facing emails got a branded shell (#251) then became **per-company editable** across web + mobile (#252–#255) — see *Post-MVP polish — editable email templates*. **Invoice & estimate "from" block (slice-tracked below):** per-invoice / per-estimate control over which company contact details (address / phone / a new business email) print in the public "from" block, with separate per-document-type company defaults, plus the company logo brought to the public estimate — across web + mobile (#257–#262); see *Post-MVP polish — invoice & estimate from-block*. **Post-Phase-9 tracks (all shipped api→web→mobile; cataloged in the *Post-MVP polish* sections below):** workspace-membership management + granular roles, onboarding welcome wizard, multi-company create/switch, social sign-in + email verification, the web design-system refactor, per-item tax, line-item product/service revenue split, password reset, login brute-force backoff, wrong-method sign-in rescue, **telemetry wiring** (consent + both emit paths, #280–#281), and the **contacts unification** (Xero-style `customers`→`contacts` rename + an expense vendor link with OCR scan-and-forget needs-review — its own *Post-MVP polish* section below). **Next: Phase 10 — production hardening + open-core seams** (public-repo prep for a real deploy; the managed layer that fills those seams is maintained out-of-repo).
**Reads:** Assumes you've read PROJECT.md and TECH-STACK.md.

The shape of work between "all decisions locked" and shipping the MVP. Eight foundation phases (0–7), a Phase 8 for the MVP-feature slices, and a Phase 9 for the mobile catch-up — roughly sequential, each builds on the previous one. Phases 0–7 are the foundation; Phase 8 is where the product becomes visible on web; Phase 9 brings the mobile app to parity.

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
| **8** | MVP features — customers + invoices first, then estimates / expenses / dashboard / AI / recurring; items catalog (Slice I) added to scope 2026-06-07 | This is where the product becomes visible | ✅ Shipped — full MVP web scope feature-complete (slices 8.1–8.4f, 8.5a–8.5e, 8.6a–8.6c, 8.7a–8.7e, 8.8a–8.8b, L1–L4, 8.9a–8.9h, 8.10–8.15, R1–R4, I1–I5, PRs #82–#84, #86, #92, #95, #97–#100, #102–#104, #107, #108, #110, #112–#118, #120–#125, #127–#132, #135, #136, #142–#154, #167–#171 — plus mid-phase footguns #87, #88, #90, #91 and quick-follow fix #96). |
| **9** | Mobile catch-up (M1–M11f) | The RN/Expo app (Phase 6 shell) reaches feature parity with the web MVP | ✅ Shipped (slices M1–M11f, PRs #174–#190) |
| **10** | Production hardening + open-core seams | Make the product deploy-ready and add extension points (community defaults keep self-host whole) | ⏳ Next |

Foundation shipped (Phases 0–7); Phase 8 delivered the full MVP web scope; Phase 9 brought the mobile app to feature parity. **Phase 10 (next)** hardens the product for production and adds the open-core extension seams; remaining product work is polish + ship (PROJECT.md).

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

**Realized:** shipped in early PRs along with a production-readiness pass (signed commits, PR-required branch protection, Dependabot, CodeQL, secret scanning, SECURITY.md). (The detailed production-readiness log is kept off-repo.)

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

**Slice 8.5 — send-invoice chain (self-host + SaaS Connect complete):**

| Slice | PR | What landed |
|---|---|---|
| 8.5a | #100 | Public invoice view — the unauthed page the recipient lands on. Migration 0021 adds `public_token` (text, nullable, unique-indexed) to invoices. `transitionInvoice` mints 32 random bytes hex (same pattern as the invitation token — large enough that brute-force enumeration is uneconomical even without rate limiting) on `mark-sent` when the row has none; other transitions leave it alone. Idempotent so a future re-send keeps the URL stable. Status-transition audit row now carries `publicToken` in before/after alongside the existing status + stamps. `rls-context` middleware gained `PUBLIC_PATH_PATTERNS` (currently `/^\/api\/public\//`) that early-returns `next()` *before* the session check — no auth, no tenant. `GET /api/public/invoices/:token` reads via `bootstrapDb` (RLS would hide everything under the missing `app.current_account_id` setting — the bootstrap-reads watch since #90/#91) and returns customer-facing fields only (header, line items, customer name, sender company name, status, stamps, totals) — account_id / company_id / customer_id / audit trail stay out of the response. Web mirror: `hooks.server.ts` gained a `PUBLIC_PREFIXES` list (currently `['/i/']`) that bypasses the auth redirect, and the new `/i/[token]` route lives outside the `(app)` and `(auth)` groups so it only inherits the root layout (no app chrome on what the recipient sees). Uses a direct `event.fetch` not the typed `api.server` client so no cookie / x-account-id leaks from a stray hydration. Invoice detail page surfaces the absolute share URL once the token exists, built off `event.url.origin` so it works behind any proxy without an extra env var; copy/paste pending the 8.5b email-send slice. |
| 8.5b | #102 | Email transport. New `POST /api/invoices/:id/send` transitions `draft → sent` and emails the recipient with the public-view URL, or resends without transitioning when already `sent`. Mailer is an inline two-driver abstraction (Resend over fetch, console fallback for dev / self-host without `RESEND_API_KEY`); SMTP defers to a future slice when the first self-host operator needs it. Email I/O runs **outside** the audit tx so a Resend 5xx surfaces as 502 with the status flip already committed — a failed send must not silently roll back `mark-sent` and leave the audit trail lying about what happened. Web detail page promotes "Send invoice" as the primary CTA with a collapsible to-override field; "Mark sent without email" stays available for the out-of-band case. Success banner survives the post/redirect via `?sent=<address>` in the URL. `invoiceSendSchema` added to `@thalermark/validation` so `hc<AppType>()` clients get typed access to the optional body. |
| 8.5c | #108 | Self-host pay link — recipient hits Pay on `/i/[token]`, Stripe Embedded Checkout mounts inline, webhook fires and marks the invoice paid. **Scope deliberately self-host only:** a single `STRIPE_SECRET_KEY` routes all payments to whoever owns that key — correct for self-hosted freelancers (they're their own merchant), wrong for SaaS where a tenant's customer would otherwise pay Thalermark instead of the tenant. SaaS multi-tenant routing needs Stripe Connect (connected accounts + onboarding + `stripeAccount` header on session mint) and lands in 8.5d (onboarding) + 8.5e (connected payments); the flow built here doesn't change — Connect adds one parameter to checkout-session creation and an onboarding gate, the Embedded Checkout / webhook / idempotency / audit machinery all carry over. New `apps/api/src/lib/stripe.ts` wraps the SDK with `createStripeBundle` returning `null` when any of the three `STRIPE_*` env vars is missing — Stripe-disabled is a first-class state (Pay button hidden, webhook 503s, rest of the app runs). `decimalDollarsToCents` converts our money strings to Stripe integer minor units without floating-point loss (`"0.10" → 10`), preserving [[architecture_money_decimal_strings]] end-to-end. Two new public routes via a fresh `/api/webhooks/*` public-prefix (joins `/api/public/*` in `PUBLIC_PATH_PATTERNS`, leaves room for future provider webhooks): `POST /api/public/invoices/:token/checkout-session` lazy-mints an Embedded Checkout session (`ui_mode: 'embedded_page'`, `currency=usd`, `client_reference_id=invoice.id`) only when the recipient clicks Pay — no Stripe API calls on passive page loads — and is status-guarded to `sent`; `POST /api/webhooks/stripe` verifies the signature against the raw body, filters to `checkout.session.completed` + `payment_status=paid`, and runs `mark-paid` on `bootstrapDb` (no tenant context; the signature **is** the auth). Audit attributed to the synthetic system user from migration 0009 (`auth_user.is_system` — schema explicitly anticipated this for provider callbacks). Idempotent: re-delivered events find `status === 'paid'` and 200 without writing. Web wires the existing `/i/[token]` page via a new `payable` flag the API returns; a SK action proxies the session-mint POST (cross-origin from browser to api is blocked, SK proxy is the established public-page pattern); `@stripe/stripe-js` is lazy-imported on Pay-click so recipients who never pay don't ship ~100kb of Stripe.js. After payment Stripe navigates back to `/i/[token]?paid=1` — in the common case the webhook has already committed and the page renders the Paid banner; if still in flight, a "Payment received, finalizing" banner shows until refresh. Local-dev path documented in `.env.example`: `stripe listen` prints a `whsec_…` for `STRIPE_WEBHOOK_SECRET`, then `stripe trigger` exercises the path end-to-end. |
| 8.5d | #120 | SaaS Stripe Connect onboarding + settings nav restructure. Migration 0024 adds three columns to `companies` — `stripe_connect_account_id` (text, nullable, unique-indexed), `stripe_connect_charges_enabled` (bool default false), `stripe_connect_details_submitted` (bool default false). Self-host operators on a single `STRIPE_SECRET_KEY` leave all three null; the 8.5c pay path is untouched. New `POST /api/companies/:id/stripe-connect/onboard` (tenant-context) lazily creates a Stripe Express account on first call (`type: 'express', country: 'US', card_payments + transfers capabilities`) with `Idempotency-Key: company-${id}-create-account` guarding double-click races, persists the acct id, writes a `stripe-connect-create` audit row, then mints a fresh `account_onboarding` Account Link. Idempotent: subsequent calls reuse the stored acct and just mint a new link (Stripe links expire). New `GET /api/companies/:id/stripe-connect/status` returns the flag triple + `stripeConfigured` (whether the bundle is wired). Existing `/api/webhooks/stripe` gains an `account.updated` branch (signature-verified, bootstrapDb path, looks up the company by `stripe_connect_account_id`, updates the flags, writes `stripe-connect-update` audit attributed to `SYSTEM_USER_ID`); no-ops on unknown account ids and no-state-change deliveries. Same single webhook endpoint serves both `checkout.session.completed` (platform self-host) and `account.updated` (Connect) — Stripe's dashboard toggle "listen to events on Connected accounts" must be ON; secret stays the same. **Web restructure:** top nav narrows to Invoices / Estimates / Customers; new avatar-dropdown "Settings" entry → `/settings` (redirects to `/settings/activity`); new `(app)/settings/+layout.svelte` with left-rail vertical-tab nav (Activity + Payments); `/(app)/activity/*` moved to `/(app)/settings/activity/*`; new `/(app)/settings/payments/*` with status panel + Connect button. `AuditHistory` gains `stripe-connect-create` + `stripe-connect-update` action labels and a `company` entity-type entry. PRODUCTION-READINESS.md gains a Tier 4 entry: SaaS admins won't have host access so platform Stripe credentials must move from env vars to an in-app config surface before SaaS launch. `biome.json` gains three ignore patterns (`**/Pods`, `**/*.xcassets`, `**/expo-env.d.ts`) to unblock CI — pre-existing scan noise from Expo/Xcode generated paths. **CI footguns hit during 8.5d:** (1) `vi.fn(async () => ...)` without typed args makes `mock.calls[0]` an empty-tuple type that strict tsc rejects as a 2-tuple cast — fix is `as unknown as [...]` two-step cast; (2) Stripe sandbox needs Connect explicitly enabled (`dashboard.stripe.com/connect`) before `accounts.create` works at all; (3) Stripe caches idempotent-key responses (including failures) for ~24h, so a busted dev attempt requires either a fresh company UUID or bumping the key suffix (`-v2`) until the cache expires. |
| 8.5e | #121 | SaaS Stripe Connect connected payments. Completes the SaaS payment-routing chain started in 8.5d. `GET /api/public/invoices/:token` now loads the company's `stripeConnectAccountId` + `stripeConnectChargesEnabled` and gates `payable` on `connectReady` (true when company has no connect account OR when `charges_enabled` is true); also adds a new `connectPending` boolean so the public page can render a friendly "finishing setting up online payments" banner mid-onboarding rather than silently hiding the Pay button. `POST /api/public/invoices/:token/checkout-session` loads the company, returns 503 `connect_not_ready` when onboarded-but-not-enabled, and threads `{ stripeAccount: company.stripeConnectAccountId }` as the SDK's second-arg request options when present — customer payments now land on the tenant's connected account rather than the platform's. Self-host preserved: companies with null `stripeConnectAccountId` still hit the 8.5c platform path (no `stripeAccount` passed). **Webhook needs no change** — `client_reference_id` resolves the invoice regardless of which Stripe account hosted the session; pinned by a new regression test that delivers `checkout.session.completed` with `account: 'acct_<connected>'` set. Web: `apps/web/src/routes/i/[token]/+page.svelte` gains a `{:else if inv.connectPending && inv.status === 'sent'}` banner branch; the explicit `PublicInvoice` type in `+page.server.ts` (manual cast, not the typed `hc<AppType>` client per the slice 8.5a no-cookie-leak invariant) gets `connectPending: boolean` added. 6 new integration tests bring `stripe-connect.integration.test.ts` to 15 (full api suite at the time of merge: 168). The `connectPending` field + banner came in the same PR as the core route change rather than a follow-up slice. |

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
| L1 | #122 | Ledger foundation. New `chart_of_accounts` + `journal_entries` + `journal_lines` tables (migration 0025) and `companies.business_type` column; hand-written 0026 adds NULLIF tenant-isolation RLS + CHECK constraints (account_type, normal_balance, side, amount > 0) + a DEFERRABLE constraint trigger on `journal_lines` enforcing per-entry sum-to-zero + min-2-lines invariants at commit. `chart_of_accounts` is full-CRUD within tenant; `journal_entries` + `journal_lines` are append-only (SELECT + INSERT policies only, mistakes corrected via reversing entry). Sole-prop COA seed (`packages/db/src/seed/coa-sole-prop.ts`) — 26 accounts (4-digit codes: 1000s assets, 2000s liabilities, 3000s equity, 4000s revenue, 6000s+ expenses ordered to match Schedule C Part II line order) with Schedule C line numbers in a `tax_mapping` column. Depreciation deliberately omitted (needs the fixed-asset / accumulated-depreciation workflow that lands later); COGS deliberately omitted (service-led trades treat materials as Supplies per the Wave default). Signup hook seeds the COA for the default company alongside account + company + membership in the same tx. Decisions locked during scoping: standard 4-digit COA codes with separate `tax_mapping` column (vs Schedule C numbers as codes); `journal_lines.side` enum + positive amount + deferred constraint trigger enforcing sum-to-zero + min-2-lines (vs signed-amount). PROJECT.md "How the books work" section + TECH-STACK.md row + CLAUDE.md section + accountant-ux-brainstorm fix all retrofitted in the same PR so the doc set commits to hidden double-entry. Posting helper not written yet — that's L2. |
| L2 | #123 | Wire posting rules into invoice state transitions. New `apps/api/src/lib/ledger.ts` (JIT-scaffolded inline per the no-premature-package rule) with three pieces: `invoicePostingLines` (pure policy fn mapping `(from, to, amounts)` → ordered `{ code, side, amount }[]`), `postJournalEntry` (resolves COA accounts by code for the company in a single query, inserts header + lines, filters zero-amount lines, errors loudly on missing COA codes), and `postInvoiceTransition` (thin wrapper). Posting matrix: `draft → sent` = Dr AR / Cr Revenue / Cr Sales Tax Payable (if tax > 0); `draft → paid` = Dr Cash / Cr Revenue / Cr Sales Tax Payable (skips AR — none was booked); `sent → paid` = Dr Cash / Cr AR; `sent → voided` = full reversal of mark-sent; `draft → voided` = no posting. `transitionInvoice` posts inside the existing tenant tx after the audit row so a posting failure rolls the status flip + audit row back together. The Stripe webhook's `checkout.session.completed` branch now wraps its UPDATE + audit INSERT + ledger posting in a `bootstrapDb.transaction` so the deferred sum-to-zero trigger fires at commit and a posting failure rolls the status flip back — previously the UPDATE + audit were auto-committed independently. **Estimates remain informational (no postings) per the L2 spec.** Two existing integration tests (`stripe-webhook`, `stripe-connect`) that seed invoices directly bypass the signup hook and had no COA — they gained `seedChartOfAccounts` to match production. 7 unit tests over the policy matrix + 8 integration tests (taxed/untaxed mark-sent, both mark-paid paths, void reversal, void no-op, trial-balance balanced across a full life cycle, cross-account isolation) + 1 new ledger-shape test in stripe-webhook. |
| L3 | #124 | Business-type wizard at company creation. Migration 0027 adds a CHECK constraint on `companies.business_type` pinning the column to null + the five enum codes (`sole_prop`, `llc_single_member`, `partnership`, `s_corp`, `c_corp`). Null stays allowed — existing rows pre-wizard carry null and the L1 seeder maps null → sole-prop. Validation gains `businessTypeSchema` (zod enum) + `companyUpdateSchema` (sparse update with `at_least_one_field_required` refine). New tenant `PATCH /api/companies/:id` lands behind the same `hono/validator('json', ...)` pattern the customer + invoice PATCHes use, with sparse semantics (only present keys are written) so the wizard form and a future settings-rename surface share one endpoint. Audit row records the full before/after of name + businessType. **Web first-run gate** at `(app)/+layout.server.ts`: any `(app)` route load fetches `/api/companies` and 303s to `/setup` if any company still has `businessType=null`. `/setup` and `/select-company` are exempt so the wizard can render. The wizard is a single-screen form — 5 radio options + an optional name override (placeholder shows the current default seeded from email/full-name) — that PATCHes the company and redirects to `/`. fail-re-render preserves typed input via the same `untrack()` pattern the customer/invoice forms use. Per the locked decision MVP still seeds the sole-prop COA regardless of pick; the column captures the operator's real answer so the v1.x entity-aware re-seed is a backfill, not a re-prompt. |
| L4 | #125 | GL / trial-balance export endpoint. Tenant-scoped `GET /api/companies/:id/ledger/export?from=&to=&format=` returns every journal entry for a company, joined with chart_of_accounts so the export carries code + account name + account type, plus a per-account trial balance summary (debit / credit / net). Single SQL round trip (`journal_entries ⋈ journal_lines ⋈ chart_of_accounts` ordered by `posted_at, entry id, line id`), grouped in app code. Date filter on `posted_at` (calendar-day inclusive; upper bound implemented as half-open `< (to + 1 day)` so partial-day timestamps on the boundary land in the range). Flipped `from > to` and unparseable dates both return 400 — an empty CSV from a silently bad range is the accountant footgun to avoid. JSON (default) carries `{ companyId, companyName, from, to, entries, trialBalance }` with entries nested-with-lines; CSV emits one row per line with a RFC 4180-conforming escape on the free-text columns (account name + memo), `content-disposition` pushes the browser into a download with a filename derived from the company name. No pagination — exports are bulk reads and current data volume is small. 8 integration tests (balanced TB after a full life cycle, from/to filter inclusive, bad date / flipped range / cross-account / empty-company / CSV shape + row count / unknown format). **Surfaced in the web UI by #237** (post-MVP polish): this endpoint had no link from any page. #237 added a `/reports/general-ledger` page (on-screen trial balance + a "download full ledger CSV" whose columns match this endpoint) gated `reports:export`, plus client-side **CSV export on all 9 report pages** (a shared `$lib/csv.ts` `downloadCsv` + `ExportCsvButton`, built from data already loaded in the page — ungated, since the summary reports are viewable by every role, so exporting is just "save what's on screen") and a `← Reports` back link on every report page. **Footgun:** a role-gated `+page.svelte` with no loader inherits layout `data.role` fine in dev SSR but is a **prerender candidate** → a prod build renders it once session-less, `data.role` resolves `undefined`, and the gated control vanishes for everyone; the `/reports` hub needed its own `+page.server.ts` returning `{ role: locals.role }` (the lone gated page that had been relying on bare layout-data inheritance). |

**Slice 8.9 — expenses chain (the third MVP entity, ledger-aware from day one):**

Built on top of the Slice L ledger reshape so every expense posts a balanced journal entry on first write rather than being retrofitted. Order: DB → posting policy → CRUD API → web read/write → object-storage package → receipt capture → vision-LLM extraction. Receipt capture is all-tier (image always saved); extraction is Pro+/BYOK and degrades to disabled when no LLM provider is configured.

| Slice | PR | What landed |
|---|---|---|
| 8.9a | #127 | `expenses` table (migration 0028) + RLS (0029). `account_id` / `company_id`; `customer_id` FK nullable ON DELETE RESTRICT (carried from day one though MVP doesn't expose it — avoids a backfill when job-costing surfaces in v1.x); `category_account_id` + `payment_account_id` both FK → `chart_of_accounts` NOT NULL; `amount` numeric(15,2) CHECK > 0; `expense_date` bare date; `merchant` free text (no vendor entity — bills/AP deferred v1.2+); `memo`; `receipt_storage_key` + `receipt_uploaded_at` (8.9g hooks); `extraction_status` (default 'none') + `extraction_payload` jsonb (8.9h hooks); `deleted_at` (soft delete). Both later-slice column groups land here so 8.9g/h need no fresh migration. Standard NULLIF tenant-isolation RLS; app role full CRUD; `staff_readonly` SELECT-only. App code validates category is `account_type='expense'` and payment is `'asset'` (the FK alone admits any COA row). |
| 8.9b | #128 | Expense posting policy in `apps/api/src/lib/ledger.ts`. Pure `expensePostingLines({ categoryCode, paymentCode, amount })` → Dr category / Cr payment; generic `reverseLedgerLines` flips sides (reused by edit + delete); `postExpenseCreate` + `postExpenseReversal` wrappers. Wrappers take COA **codes** — the caller does the FK→code lookup in 8.9c when it validates the account types. 6 unit tests over the policy + reversal symmetry; integration deferred to 8.9c per the L2 pattern (the posting wrapper has no standalone integration test either). |
| 8.9c | #129 | Expense CRUD API + ledger wiring. `POST` / `GET` / `GET :id` / `PATCH` / `DELETE /api/expenses` (list filters companyId / from / to / categoryAccountId / q-on-merchant); each mutation wraps row write + audit + ledger posting in one `bootstrapDb.transaction` (mirrors L2). `expenseCreateSchema` / `expenseUpdateSchema` (sparse-refined PATCH) added to `@thalermark/validation`. Three decisions made during build: (1) journal `postedAt` derived from `expense_date` (midnight UTC), **not** data-entry time, so a year-boundary expense lands in the right Schedule C period (invoices still post at `now` because their economic event is the transition); (2) edit **always** reverses + reposts (no field-diff short-circuit) per the locked clean-GL decision; (3) DELETE is soft (`deleted_at`) and posts a reversal; GET-one + list hide soft-deleted (404 on a deleted row). `escapeLike` / `expenseDateToPostedAt` / `resolveCoaAccounts` helpers added; `audit-events` ALLOWED_TYPES gains `expense` (feed label = merchant). 7 integration tests. |
| 8.9d | #131 | Web `/expenses` list + `GET /api/companies/:id/accounts`. The COA-list endpoint (active rows, optional `?type=` filter via a `hono/validator('query', …)` so the typed client accepts `{ query }` on a path-param route, ordered by code) lands **here** rather than 8.9e because the list's category filter needs it; the 8.9e form comboboxes reuse it. List page: SSR via the typed `hc<AppType>` client, single-company resolves to `companies[0]`, SSR-side page-number pagination (PAGE_SIZE=25 slicing the API's full filtered set), filters from / to / category / q forwarded as query, table Date / Merchant / Category / Amount with a receipt glyph + prev/next preserving filters. Nav link added. |
| 8.9e | #130 | Web create / detail / edit pages under `(app)/expenses/`. Form: merchant, amount (text `inputmode=decimal`, money string), date (default today), category combobox (`type=expense` accounts), payment combobox (`type=asset`; **hidden input when only Cash** — `paymentPickerVisible = assetAccounts.length > 1`, default code 1000), memo. `companyId` resolved server-side in the action (never trusted from the form). Detail surfaces `AuditHistory` (entityType=expense) + soft-delete (303 to list). Edit sends memo even when empty (the sparse schema accepts `''`) so clearing works; fail-re-render seeds from `form?.values` then falls back to the loaded expense. No API change this slice. |
| 8.9f | #132 | `@thalermark/storage` package (JIT, ships-as-JS per the 7.3 invariant). `StorageProvider` interface (`putObject` / `getSignedDownloadUrl` / `deleteObject`; `name: 's3' | 'local'`). Adapters: S3 (`@aws-sdk/client-s3` + `s3-request-presigner` exact-pinned 3.917.0 — one adapter covers R2 SaaS + MinIO dev, presigned GET URLs, `forcePathStyle` default-true when a custom endpoint is set), local-FS (writes under `baseDir`, path-traversal-guarded, signed URL → relative `/api/files/<token>`). HMAC `signFileToken` / `verifyFileToken` (base64url, constant-time compare, exp check) + `readLocalObject` helper for the api serve route. `createStorageProvider(env)` factory keyed on `STORAGE_DRIVER` (`s3` | `local`, env names matching the committed `.env.example`). 15 unit tests. **No api wiring this slice** (no consumer yet) — deferred to 8.9g. |
| 8.9g | #135 | Receipt capture wired into api + web. `server.ts` builds `createStorageProvider(process.env)` opt-in (null + 503 when misconfigured, like Stripe) + `localFileServe` when driver=local; storage config read from `process.env` in the factory, **not** `env.ts`; `rls-context` `PUBLIC_PATH_PATTERNS` gains `/^\/api\/files\//`. Routes: `POST /api/expenses/:id/receipt` (multipart, ≤10MB, jpeg/png/pdf via a mime allowlist; key `accounts/<acc>/companies/<co>/expenses/<exp>/<uuidv7>.<ext>`; **DB column update + audit FIRST, `putObject` LAST** so a storage failure rolls the tenant tx back — no orphaned object, no dangling key); `GET …/receipt` (1h signed URL + contentType); `DELETE …/receipt` (null columns + audit, `deleteObject` last); `GET /api/files/:token` (public path — `verifyFileToken` + `readLocalObject`, 404 when driver=s3). Audit rows carry the storage key, never bytes. Web `/expenses/[id]`: load fetches a signed URL → `<img>` or PDF link; upload forwards multipart via raw `event.fetch` (the hc client has no typed `form` surface — added `apiBaseUrl()` / `serverApiHeaders()` exports); delete action. `AuditHistory` gains `receipt-upload` / `receipt-delete` verbs. 5 integration tests. |
| 8.9h | #136 | Receipt extraction (Pro+/BYOK) — the final expenses slice. New `@thalermark/ai` package (JIT, ships-as-JS): `ReceiptExtractor` interface + `createReceiptExtractor(env)` over the Vercel AI SDK — anthropic (default `claude-sonnet-4-6` vision) / openai / ollama (via `@ai-sdk/openai-compatible` at `${OLLAMA_BASE_URL}/v1`, **no key — the AGPL-pure local path**); pure `normalizeExtraction` formats money to 2-dp strings, guards ISO dates, and constrains the suggested category to the company's expense COA codes. **PDF receipts render page-1 → PNG via `pdf-to-png-converter` (MIT; pdfjs-dist + a native canvas, no system binaries — keeps `docker compose up` clean) for every provider — not Playwright, which the locked plan assumed but was never actually in the stack.** `@thalermark/storage` gains `getObject` so extraction reads the stored receipt back. `POST /api/expenses/:id/extract`: 503-gated on AI + storage config (opt-in like Stripe — **no `AI_FEATURES_ENABLED` flag**; the committed `.env.example` LLM block is the gate, per the 8.9f precedent), 400 `no_receipt`, runs the model **inside the tenant tx but catches errors to commit `extraction_status='failed'` + 502** (the 8.5b email-path shape, so the throw doesn't roll back the status the UI needs to see), persists status + payload, audits `receipt-extract`, emits opt-in `expense_categorised{ai_suggested}` telemetry when a code is suggested, and returns the suggestions with the code resolved to an account id. Web: detail-page "Auto-fill from receipt" → redirect to the edit form pre-filled (`?prefill` query, "Pre-filled from your receipt" banner; the user reviews + saves — the AI never writes the ledger directly). 7 ai unit tests + 5 api integration tests (a stub extractor — no live model call). |

**Slice 8.10 — position dashboard:**

| Slice | PR | What landed |
|---|---|---|
| 8.10 | #142 | Position dashboard — the "in / out / owed / owing" home screen (PROJECT.md's headline answer-not-accounting promise). `GET /api/companies/:id/dashboard` computes money-in / money-out (MTD + all-time) off cash-account journal lines, AR owed (unpaid sent invoices), and a recent-activity slice in one tenant round trip. Web `(app)` home (`/`) renders the tiles SSR. |
| 8.10-fix | #144 | Dashboard cash-flow reversal bug. money-in/out summed raw debits/credits on cash accounts, but the immutable ledger posts a reversing entry on every expense edit/delete (expense "Cr Cash" → reversal "Dr Cash"), so an edited expense counted as money IN and inflated gross OUT — an expense edited twice showed as income. Fix nets signed cash movement **per `source_entity_id`** before splitting by direction (create+edit → latest amount, create+delete → zero, invoice payment still money in); identical to the old sum when no reversals exist. **Recurring footgun class:** any future flow-metric aggregate over `journal_lines` must net per source, not sum raw sides. +1 regression test. |

**Slice 8.11–8.14 — AI insight layer (Pro+/BYOK):**

The four insights that complete the MVP AI layer (receipt extraction, the 5th, shipped in 8.9h). Pattern on the LLM ones: **deterministic signals computed in SQL → the LLM only narrates, never does ledger arithmetic.** Each LLM insight is opt-in (503 when no LLM is configured); the two deterministic ones are always on.

| Slice | PR | What landed |
|---|---|---|
| 8.11 | #143 | Text expense categorization — first text (non-vision) AI insight. **Model-role split in `packages/ai`:** `resolveModel(env, role)` with `ModelRole = vision \| reasoning \| fast` + per-provider `DEFAULT_MODELS`; categorization uses the `fast` role. `createExpenseCategorizer` (text-only `generateObject`) + stateless `POST /api/expenses/categorize` (opt-in 503; ✨ Suggest button on the expense forms). Footguns: Ollama's `createOpenAICompatible` needs `supportsStructuredOutputs:true` or it silently drops the JSON schema; a **named** SvelteKit `suggest` action makes a sibling `default` action illegal at runtime (renamed `default`→`save`); `use:enhance` resets the form on success (fixed with `update({ reset:false })`). |
| 8.12 | #145 | Cash-flow nudges — first `reasoning`-role consumer. `createCashFlowAdvisor` turns computed signals (cash on hand, MTD in/out, trailing-3-month, AR owed, overdue count) into ≤3 plain-English nudges `{text, tone}`. `GET /api/companies/:id/cash-flow-nudges` hashes the signals and caches them on `companies` (migration 0030); the cache key folds in `CASH_FLOW_NUDGE_VERSION` so a prompt change (which doesn't move the signal hash) still invalidates — **bump that constant when the prompt or signal shape changes.** Reversal-safe netting + AR balance extracted to shared `ledger.ts` helpers (`cashFlowNet` / `cashOnHand` / `arBalance`) and the dashboard refactored onto them (one source of truth for the netting). Dashboard streams the nudges as an un-awaited promise (instant tiles, `{#await}` below). |
| 8.13 | #146 | Late-payer detection — the brief's "this client pays late 80% of the time". **Deliberately deterministic, no LLM** (user picked this over an AI-narrated variant — the figures ARE the insight, must be instant + trustworthy). `GET /api/customers/:id/payment-reliability`: one aggregate → `{paidCount, lateCount, latePct, avgDaysLate, overdueCount, overdueTotal}`. `avgDaysLate` averages over **late invoices only** (a test caught that averaging over all paid invoices let a far-future due date swing it wildly negative). Tone-colored "Payment reliability" panel on the customer detail page. |
| 8.14 | #147 | Spending anomaly flagging — the last MVP AI insight ("expenses 40% higher than your 3-month average"). Deterministic. `GET /api/companies/:id/spending-anomalies` computed straight off the `expenses` table (edits update in place + deletes set `deleted_at`, so `sum(amount) where deleted_at is null` is the correct current total — **no** ledger-reversal handling, unlike the cash-flow metrics). **Rolling 30/90-day windows, not calendar months** (avoids the partial-month trap). Flags overall (recent ≥ +40% over baseline) + per-category spikes (≥ +50% AND ≥ $50). Dashboard "Unusual spending" section, shown only when something flags. **→ MVP AI insights layer complete — all five: receipt extraction (#136), categorization (#143), nudges (#145), late-payer (#146), anomaly (#147).** |

**Slice 8.15 — duplicate-as-template:**

| Slice | PR | What landed |
|---|---|---|
| 8.15 | #148 (invoices), #149 (estimates + expenses) | Duplicate any record as a fresh starting point. **Invoices + estimates = server clone:** `POST /api/{invoices,estimates}/:id/duplicate` clones header + line items into a new DRAFT (new auto-number, today/Net-30 or today/+30-expiry; status/stamps/public-token reset; estimate also clears the converted-invoice link). **Repeatable — no idempotency link** (unlike the 8.7d convert); any source status is a valid template; the detail-page "Duplicate" button lands on the new draft's edit page. **Expenses = web-only form prefill, NOT a server clone** (the key design call): an expense posts to the ledger on create (no draft state), so a server clone would silently post a second journal entry — instead "Duplicate" links to `/expenses/new?duplicate=<id>` and the new-expense `load` seeds merchant/amount/category/paid-from/memo (date → today) for the user to review + save. The invoice/estimate clone is safe precisely because drafts don't post until mark-sent. 6 integration tests. |

**Follow-up #150 — per-company From + Reply-To on sent email.** Sent invoice/estimate email swaps the From **display name** to the company's name (the address stays on the verified `EMAIL_FROM` domain so Resend/SPF still pass) and routes replies to a per-company `reply_to_email` (migration 0031) when set. New `formatSender` helper in `apps/api/src/lib/sender.ts`, threaded through the invoice + estimate `/send` paths.

**Slice R — recurring invoices (the last web MVP feature; first pg-boss consumer):**

Auto-generate + email invoices on a cadence, no card-on-file (locked MVP scope). Sequenced last among web features because it stands up pg-boss (Postgres-backed background jobs) for the first time. Order: schema → CRUD → generation engine + scheduler → web UI.

| Slice | PR | What landed |
|---|---|---|
| R1 | #151 | `recurring_invoices` + `recurring_invoice_line_items` tables (migration 0032) + RLS + CHECKs (0033) + `invoices.recurring_invoice_id` provenance FK (ON DELETE SET NULL, mirrors `estimates.converted_invoice_id`). A schedule is a distinct entity — no number / issue date / public token (those are minted per generated invoice). Cadence = `frequency` (weekly/monthly/yearly) × `interval_count` ("every N"); end conditions independent + optional (`end_date` and/or `max_occurrences`, tracked by `occurrence_count`); status active/paused/ended; `net_terms_days` drives the generated invoice's due date. Validation schemas added. **Footgun (CI db:lint / squawk):** counter columns must be `bigint` (prefer-bigint-over-int) and the line-items→schedule FK needs an explicit short name via the table-level `foreignKey()` builder (identifier-too-long — drizzle's auto-name exceeds Postgres's 63-byte limit). |
| R2 | #152 | CRUD + pause / resume / end. `RECURRING_TRANSITIONS` (active→paused→active; active\|paused→ended, terminal). resume pulls a past `next_run_date` forward to today so a long pause doesn't back-date the next invoice; PATCH is blocked once ended and re-pins `next_run_date` to `start_date` only before the first run (`occurrence_count===0` — otherwise `next_run_date` / `occurrence_count` are sweeper-owned runtime state). `GET :id` returns line items + `generatedInvoices` (via the provenance link). Audit entityType `recurring_invoice` threaded through the `/api/audit-events` feed (customer-name label join) + `AuditHistory` (pause/resume/end verbs). 14 integration tests. |
| R3 | #153 | Generation engine + pg-boss sweeper — the infrastructure slice. `apps/api/src/lib/recurring.ts`: `generateOnce` (clone template → invoice minted directly `sent` + public token + provenance, posts the draft→sent ledger entry via the reused `postInvoiceTransition`, emails best-effort, then advances the schedule — `next_run_date` stepped forward until strictly future so missed occurrences after downtime **collapse to one invoice**, issued dated today to avoid back-dating; ends on `max_occurrences` / `end_date`); `advanceDate` (weekly/monthly/yearly × interval, month-end clamp in UTC); `sweepRecurringInvoices` (cross-tenant scan via `bootstrapDb` BYPASSRLS → per-schedule `withAccountContext`, attributed to `SYSTEM_USER_ID`; one schedule's failure is logged and skipped). **pg-boss boots in `server.ts`** on the superuser `DATABASE_URL` (it owns its `pgboss` schema, needs DDL — not the `thalermark_app` runtime role), schedules the sweep on `RECURRING_SWEEP_CRON` (default 06:00 UTC), and stops on shutdown; a scheduler-start failure is logged but never crashes the HTTP server; it lives only in `server.ts` so the integration suite never boots pg-boss. `POST .../run-now` = a manual/dev trigger (user-attributed) running the same engine. **DRY extractions:** invoice email builder → `lib/invoice-email.ts` (and the `/send` route refactored onto it), `escapeHtml` → `lib/html.ts`, number suggesters → `lib/invoice-number.ts` (the last two avoid an `app.ts` ↔ `recurring.ts` import cycle). **pg-boss dependency footgun (durable):** pg-boss hard-deps `kysely`, which drizzle-orm carries as an *optional* peer — two kysely versions forked drizzle-orm into two type-incompatible copies and blew up typecheck; fixed with a root `pnpm.overrides` pinning `kysely: 0.28.17` (satisfies pg-boss `^0.28.15` and drizzle's `*`). pg-boss is ESM-only → named `import { PgBoss }`. 4 `advanceDate` unit tests + 9 generation/sweep integration tests. |
| R4 | #154 | Web UI — `/recurring` list / new / [id] / [id]/edit + "Recurring" nav link + shared `cadenceLabel` (`$lib/recurring.ts`). Mirrors the estimates pages. Numeric fields (interval / maxOccurrences / netTerms) cross as JSON numbers, money as decimal strings. Detail page shows the generated-invoices run history + pause / resume / end / "generate next now"; edit gated to non-ended schedules at `load()`. Browser-smoke verified end-to-end (UI → run-now → `sent` invoice → email dispatched). **→ recurring done; the web MVP is feature-complete.** |

**Slice I — items / products & services catalog (scoped 2026-06-07; shipped I1–I5, PRs #167–#171):**

A reusable per-company catalog of saved line items, surfaced two ways: a **type-ahead on every line-item form** (invoice / estimate / recurring) and a **management surface** at `/settings/items`. Added to MVP scope on 2026-06-07 as an explicit decision beyond the 2026-05-10 lock (PROJECT.md "Items (Products & Services)"). Mirrors the customers feature in shape (per-company, RLS-fenced, CRUD + web pages).

Two load-bearing design calls, both settled during scoping:
- **Snapshot, not reference.** Picking an item *copies* its description / unit price / quantity into the line; the line stays a free-text snapshot (same philosophy as `invoice_line_items.amount` being a stored column — historical totals must be reproducible). Editing or archiving a catalog item never rewrites a sent invoice. Each line *also* stores a nullable `source_item_id` FK (ON DELETE SET NULL) **purely as a reporting breadcrumb** — displayed values always come from the snapshot. **The FK must land with the items table (I1), not later: once a line is free text it can't be back-attributed to an item.**
- **Archive, never hard-delete.** Items carry an `archived_at` flag — archived items drop out of the picker (`WHERE archived_at IS NULL`) but keep the FK + sales history intact, so the top-products report never gets holes punched in it. No DELETE endpoint; archive/restore transitions instead. (Contrast customers' RESTRICT-on-delete — items reach the same "never lose history" end via archive because deletion would orphan the report.)

Order: schema + FK → CRUD API → management web surface → autocomplete → report.

| Slice | Plan |
|---|---|
| I1 | `items` table — company-scoped (`company_id` notNull, `account_id` denormalized, standard NULLIF RLS) with `name` (picker + report label), `description` (flows into the line), `unit_price` numeric(15,2), `unit_label` text nullable, `default_quantity` numeric(15,4) default `1`, `archived_at` timestamptz nullable. Plain `(company_id, name)` index (NOT unique — names repeat) to back the autocomplete `ILIKE`. Same migration adds the nullable `source_item_id` provenance FK (ON DELETE SET NULL) to `invoice_line_items`, `estimate_line_items`, and `recurring_invoice_line_items`. `itemCreate` / `itemUpdate` schemas in `@thalermark/validation`. **Footgun watch (R1 precedent):** the three new FKs need explicit short names via the table-level `foreignKey()` builder or squawk's identifier-too-long trips. |
| I2 | Items CRUD API mirroring customers: `POST /api/items`, `GET /api/items?companyId=&q=` (`q` drives a capped `ILIKE`, archived rows filtered out), `GET /api/items/:id`, `PATCH /api/items/:id` (validator-middleware, full-replacement), plus `POST .../archive` + `.../restore` transitions in place of a hard DELETE. Audit `entityType: 'item'` (create / update / archive / restore) threaded through the `/api/audit-events` feed + `AuditHistory` labels. |
| I3 | Item management web surface at `/settings/items` (list / new / edit + archive/restore), modeled on `/customers`. Archived items hidden by default with a show-archived toggle. New left-rail "Items" tab in the settings nav. |
| I4 | Line-item autocomplete component, wired into the invoice + estimate + recurring line-item forms (one shared component — they already share the form shape). Type-ahead reads `GET /api/items?q=`; picking prefills description + unit price + default quantity and stamps `source_item_id`; a hand-typed line leaves `source_item_id` NULL. Snapshot semantics preserved — the server still recomputes money authoritatively per [[architecture_money_decimal_strings]]. |
| I5 | "Top products" report (capstone — the payoff of the I1 FK). Deterministic `GROUP BY source_item_id` aggregate over line items (`SUM(amount)`, `COUNT(*)`), no second datastore (matches the AI-layer deterministic-signals pattern). **Framed as a management/sales lens, explicitly NOT GL-reconciled:** pre-tax, catalogued lines only, with an "Uncatalogued / other" bucket for NULL-source lines so product rows + uncatalogued tie back to GL revenue on a matched basis. Report states its basis (paid-only vs sent). **In MVP** (confirmed 2026-06-07) — sequenced last in Slice I, building on the I1 FK. |

**Realized (slice numbering, all shipped 2026-06-07):**

| Slice | PR | What landed |
|---|---|---|
| I1 | #167 | `items` table (company-scoped, NULLIF RLS, `unit_price` default `'0'` / `default_quantity` default `'1'`, `archived_at`, plain `(company_id, name)` index) + migration 0038 / hand-written RLS 0039. Same migration added the nullable `source_item_id` provenance FK (ON DELETE SET NULL) to all three line-item tables via the table-level `foreignKey()` builder with explicit short names (R1 precedent — though the auto names actually fit under 63 bytes here). `itemCreate` / `itemUpdate` zod schemas. Schema + RLS-isolation tests, including the load-bearing source-deleted → FK-nulls-but-snapshot-survives case. |
| I2 | #168 | Items CRUD mirroring customers: `POST` / `GET` (`?companyId=&q=&includeArchived=`) / `GET :id` / `PATCH` (validator-middleware, full-replacement). **Archive/restore transitions replace a hard DELETE**, idempotent (no-op transition returns 200, writes no audit row). `q` drives a capped (20) `ILIKE` with `escapeLike`. Audit `entityType: 'item'` threaded through the `/api/audit-events` feed (items.name label join) + `AuditHistory` (Item label, `/settings/items` path, archive/restore verbs). **Delta vs plan:** added the `includeArchived` query param (forward-compat for the I3 show-archived toggle). 18 integration tests. |
| I3 | #169 | Management surface at `/settings/items` (list with show-archived toggle + inline archive/restore, detail with history, new, edit), modeled on `/customers`. New Items tab in the settings left-rail. **Delta vs plan:** added a detail page (`[id]`) — the plan said "list / new / edit," but a detail page is where archive/restore + per-entity history live and it's what the I2 audit-feed `/settings/items/{id}` link resolves to (the `/customers` model it mirrors has one). |
| I4 | #170 | Line-item autocomplete wired into all six forms (invoice / estimate / recurring × new + edit). `ItemPicker.svelte` — the description cell becomes a debounced, aborting combobox over a new same-origin `/items/search` proxy; picking prefills description / unit price / default quantity and stamps `source_item_id`, typing by hand clears it. `sourceItemId` added to the three line-item input schemas and carried through every API insert path — including the clone/derive paths (invoice + estimate duplicate, estimate→invoice convert, recurring sweeper) so the report stays whole. **Deltas vs plan:** the shared component is the autocomplete only (the six forms still own their row markup, which already shared the shape); the menu is `position: fixed` anchored to the input rect so it escapes the line-item table's `overflow-hidden` wrapper (a clipping bug caught in manual testing). |
| I5 | #171 | `GET /api/companies/:id/top-products?basis=paid\|sent` — deterministic `GROUP BY source_item_id` aggregate (`SUM(amount)` pre-tax, `COUNT(*)`) with a `LEFT JOIN items` for the label, a single "Uncatalogued / other" bucket (null source) sorted last, and a query-validator that types `basis` for the hc client + 400s an unknown value. Archived items keep their name via the left join. Web `/reports/top-products` (table + total, Paid/Sent toggle, rows link to the item) + a Reports nav link. 6 integration tests. |

**Mid-phase footguns surfaced and fixed:**

- **#87 — `active_company_id` → `active_account_id` cookie rename.** The cookie name from slice 5.4 implied a future company-level picker, but the value has always carried an `account_id` UUID (memberships are account-level in MVP) and the misnaming kept biting every consumer that touched it. Hard-cut rename — no production users, no migration needed. Touched `hooks.server.ts`, `app.d.ts`, the `select-company` action, and the new `api.server.ts` reader. The Phase 5 §5.4 deltas note now reflects the renamed name.
- **#88 — api connects as `thalermark_app`, not the superuser.** Production runtime now uses the non-BYPASSRLS `thalermark_app` role (created back in migration 0005) so RLS policies actually fire as the primary tenancy fence rather than as quiet defense-in-depth behind a superuser pool. Two connection strings: `DATABASE_URL` (superuser, DDL only — migrations + boot-time role provisioning); `APP_DATABASE_URL` (runtime, `thalermark_app`). When `THALERMARK_APP_PASSWORD` is set, `server.ts` runs `ALTER ROLE thalermark_app WITH LOGIN PASSWORD <env>` at boot — idempotent, so rotation is a redeploy; operators with out-of-band role provisioning leave the password empty. Self-host compose threads both env vars in with sensible defaults so out-of-box `docker compose up` keeps working. Integration tests stay on the testcontainer-superuser pattern; promoting them is a worthwhile follow-up. **Self-host operators with an existing `.env` must add `THALERMARK_APP_PASSWORD` on next pull** (or accept the `thalermark_app` default).
- **#90 + #91 — bootstrap reads under `thalermark_app`.** #88 swapped the runtime pool but left `/api/me` and `rls-context`'s pre-tx membership probe on the tenant handle. Both run before `x-account-id`, and the accounts / memberships RLS policies gate visibility on `app.current_account_id` (unset on bootstrap), so every authed request to a tenant route 403'd and `/api/me` reported zero memberships even when rows existed — the sign-up hook was correctly creating account + company + membership, but the bootstrap reads couldn't see them, so the web shell bounced every new user to `/select-company`'s "not set up" screen. #90 added an optional `bootstrapDb` on `AppDeps` + `RlsContextDeps` (defaults to `db` for the testcontainer-superuser tests) and routed the two reads through it. #90 was incomplete — it shipped without the `apps/api/src/server.ts` hunk that constructs the second pool and passes it in, so `bootstrapDb` fell back to `db` and the bug stayed live on main. #91 added that hunk and renamed `authDbHandle` → `bootstrapDbHandle` since it now serves more than BA. **Watch this pattern** — any future API surface that reads before tenant context (a future `/api/me/*` route, an unauthed public-invoice fetch) must go through `bootstrapDb`, not `db`, or it will silently return zero rows under RLS.

---

## Phase 9 — Mobile catch-up (M1–M11f)

Phase 6 shipped the **mobile shell** (auth, bearer/Origin contract, tab nav, empty home); the feature screens were deferred so the web flow could land first. Phase 9 is that catch-up: the RN/Expo app reaching feature parity with the web MVP, built as per-slice PRs that **mirror `apps/web/src/routes/(app)/…`** against the same Hono API. Native UI, shared `@thalermark/validation` schemas, shared `@thalermark/brand` tokens via NativeWind. Sequenced after the user declared the web MVP feature-complete (2026-06-03).

**Read `apps/mobile/CLAUDE.md` before any mobile work** — it carries the load-bearing contracts (bearer + `Origin: thalermark://` + `x-account-id`, decimal-string money, `source_item_id` per line) that mobile must satisfy independently as a second API client.

Order: foundation → the entities in dependency order (customers → invoices → estimates → expenses → items → recurring) → dashboard/AI → account admin → an M11 polish round-up. M11 split into sub-slices a–f.

| Slice | PR | What landed |
|---|---|---|
| M1 | #174 | Active-account / `x-account-id` foundation — closes the gap flagged in `apps/mobile/CLAUDE.md`. `lib/api.ts` stamps `x-account-id` from a stored active account; `lib/active-account.ts` resolves it (mirror of web's `hooks.server.ts`: `/api/me` → auto-pick single membership, honor stored choice, else the new `(app)/select-company` picker); `signOut()` clears it. Without this every tenant route 403s under RLS. |
| M2 | #175 | Customers — tab → list / create / read-only detail. Client-side dupe detection ported verbatim to `lib/customer-dupes.ts` (email exact = hard block, name normalized = advisory; no server dupe endpoint). Auto-picks `companies[0]` for `companyId`. Added `@thalermark/validation` as a mobile dep; Ionicons fixed the placeholder tab icons. |
| M3 | #176 | Invoices — tab → list (joins customers) / read-only detail / create. Customer picker + inline-new-customer (reuses M2 dupe logic); line items via `components/ItemPickerField.tsx` (RN port of web's `ItemPicker` — type-ahead over `GET /api/items?q=`, stamps `sourceItemId` on pick / clears on hand-type); decimal-string money helpers; number auto-prefill. **Footgun caught:** a once-only bootstrap `useFocusEffect` must gate re-entry with a `useRef`, not a state var in the dep array (state-in-deps re-runs the effect mid-flight and drops a pending fetch). |
| M4 | #177 | Invoice status actions — detail toolbar: send/resend, mark-paid (method/reference/date panel), void, mark-sent, gated by `INVOICE_TRANSITIONS`; paid/voided terminal; Paid via/on block; share link. `act()`+reload pattern. |
| M5 | #178 | Estimates — tab → list / detail / create, a copy-adapt of M3/M4. Deltas: no dueDate, optional `expiresOn`; transitions send / mark-accepted / decline / mark-sent + **convert-to-invoice** (navigates to the created invoice, idempotent). No payment semantics. |
| M6 | #179 (M6a) · #180 (M6b) | Expenses — tab → list / detail / create. M6a manual entry posts against two COA rows, so the form fetches `GET …/accounts?type=expense\|asset` and offers Category + Paid-with pickers. M6b receipt capture+extraction: `expo-image-picker` (added dep + app.json perms) → upload → `<Image>` thumbnail (token-gated `/api/files` URL) → `POST …/extract` (vision LLM) → review card → Apply via PATCH → Remove. **FOOTGUN (any mobile upload):** the SDK's global `fetch` rejects RN's `{uri,name,type}` multipart shim — uploads must go through `XMLHttpRequest` (`lib/upload.ts`). |
| M7 | #181 | Recurring invoices — NOT a tab; reached via a link on the invoices list → `invoices/recurring/{index,new,[id]}.tsx` in the invoices Stack. Create = invoice form minus number/issue/due + cadence (frequency chips, every-N, start/end, maxOccurrences, netTermsDays — counters are JSON numbers). Detail: run-now / pause / resume / end. **Footgun:** adding NEW route files while Metro runs needs a FULL reload (press `r`) — fast-refresh doesn't register new routes, so a new path falls through to a sibling `[id]` catch-all. |
| M8 | #182 | Position dashboard + AI insights — rewrote the Home tab from the Phase-6 placeholder: 3 position tiles (`GET …/dashboard`) with a period selector (month/30d/ytd), deterministic "Unusual spending" anomalies (`/spending-anomalies`, shown only when flagged), AI "What to watch" cash-flow nudges (`/cash-flow-nudges`, best-effort → empty on 503). Sign-out moved into the header. |
| M9 | #183 | Items catalog mgmt + top-products report — introduced a **6th "More" tab** (`more/_layout.tsx` Stack + `more/index.tsx` hub) as the home for screens that don't earn a top-level tab. Products & services (`more/items/{index,new,[id]/index,[id]/edit}.tsx`): list w/ show-archived toggle + inline archive/restore, detail, create, edit; shared `components/ItemForm.tsx`; items **archive not delete**. Top products (`more/top-products.tsx`): Paid/Sent basis toggle, per-item revenue + count, "Uncatalogued / other" bucket, rows link to the item. |
| M10 | #184 | Account admin — team + invites + account switcher, hung off the M9 "More" hub. `more/team.tsx` (members + invite-by-email + pending invitations; invite POSTs via a new `lib/invitations.ts` **raw-fetch helper** since `POST /api/invitations` has no json validator). `more/switch-account.tsx` (in-app switcher: lists `/api/me` memberships, on pick stores active id + `router.replace('/')` to re-scope). **Intentional divergence (user decision):** mobile gates "Switch account" to `memberships.length > 1` (hidden for solo users); web's UserMenu always shows it. |
| M11a | #185 | Native date pickers — `components/DateField.tsx` wrapping `@react-native-community/datetimepicker` (SDK-canonical 9.1.0 via `expo install`, bundled in Expo Go — no custom dev build). Value stays ISO `yyyy-mm-dd` (payloads unchanged), TZ-safe via local Y/M/D parts (not `new Date(iso)`/`toISOString()`); iOS inline + Android dialog; **uses `onValueChange`+`onDismiss`, NOT the deprecated `onChange`**. Swapped into all four create forms. |
| M11b | #186 | Customer + expense edit (the no-line-item docs). Customer edit = full-replacement (omit-empty clears); expense edit = sparse-merge (memo sent even blank — `''` is a valid clear; API re-posts the ledger as reversal + fresh). |
| M11c | #187 | Invoice + estimate edit (**draft-only** — the detail Edit button gates on `status==='draft'`). Full-doc PATCH (`{invoice,estimate}UpdateSchema` = create minus companyId); **each line carries `sourceItemId` through unchanged** or editing would null the top-products breadcrumb. **Route-reshape pattern (M11b–c):** a `[id].tsx` detail file becomes `[id]/index.tsx` so an `[id]/edit.tsx` sibling can exist (expo-router file-vs-folder collision; git tracks as renames). |
| M11d | #188 | Duplicate-as-template — two mechanisms mirroring web: invoice/estimate use the server `POST …/:id/duplicate` (clones to a draft, carries `sourceItemId`, lands on the new draft's edit screen, any status); **expense uses client prefill via `/expenses/new?duplicate=<id>`** (never silently posts to the ledger — seeds merchant/amount/category/paid-with/memo, not date or receipt). |
| M11e | #189 | Per-entity audit history — shared **`components/AuditHistory.tsx`** (port of web's `AuditHistory.svelte`: action verbs + collapsible before/after diff lines + relative time). **Presentational** — host screens fetch `/api/audit-events?entityType=&entityId=` inside their existing `load()`/focus fetch and pass `events` down, so it auto-refreshes after in-screen mutations; the audit read is best-effort/swallowed so it never flips the screen to error. Wired into **all six** entity detail screens (customer / invoice / estimate / expense / recurring / item — item included for full parity, beyond the planned 5). |
| M11f | #190 | Nav consolidation + settings (the capstone). Trimmed the bottom bar 6 → **5 tabs** (Home / Invoices / Expenses / Customers / More); **Estimates lost its tab** (`href:null`, routable) and moved into the More hub's new **Sales** section with Recurring. Hub also gained **Activity** (`more/activity.tsx` — account-wide feed from unfiltered `/api/audit-events?limit=100`, rendered by **feed-mode `AuditHistory`**: new `showEntity` prop adds a tappable entity prefix that deep-links to the detail screen) and a **Settings** section: **Business** (address/phone PATCH + logo preview/image-picker-upload/remove; new `uploadLogo` sharing `upload.ts`'s XHR-multipart path), **Email** (reply-to PATCH), **Payments** (Stripe Connect status + onboard via **RN `Linking.openURL`** → system browser, focus refetch picks up webhook-updated status; + offline cash/check/Venmo/Zelle methods PATCH). No new native dep. |

**Mobile footguns (durable — preserve; from `apps/mobile/CLAUDE.md` + the slices above):**

- **`x-account-id` on every tenant request** — `lib/api.ts` stamps it from the resolved active account; without it tenant routes 403 under RLS (mobile's equivalent of web's `active_account_id` cookie → `locals.activeAccountId`).
- **Bearer + `Origin: thalermark://`** on every request (RN omits `Origin`, tripping BA CSRF + `TRUSTED_ORIGINS`); `hc<AppType>` headers must be a dynamic async fn; `import type { AppType }` (value import breaks Metro).
- **Multipart uploads go through `XMLHttpRequest`, not `fetch`** — the SDK's spec-compliant `fetch` rejects RN's `{uri,name,type}` file shim ("Unsupported FormDataPart implementation"). See `lib/upload.ts` (`postMultipart` shared by `uploadReceipt` + `uploadLogo`).
- **New route files need their types regenerated** — `.expo/types/router.d.ts` is written by a running Metro. A *running* user Metro picks new routes up on save (M11f); if none is running, start a **throwaway `npx expo start --port 8082`** (capture its PID, `kill` it after types appear) — never `pkill -f "expo start"` (kills the user's server). At runtime, a brand-new route also needs a full reload (press `r`) or it falls through to a sibling `[id]` catch-all (M7).
- **Expo SDK canonical version pinning** — RN/Expo peer ranges are loose, so a bot bump can move `react`/`react-dom` a patch ahead of the SDK's canonical version and crash launch in Expo Go ("Incompatible React versions"). Run **`npx expo install --check`** after dep bumps; canonical versions live in `node_modules/expo/bundledNativeModules.json`.
- **`source_item_id` is a snapshot breadcrumb every client must carry** — line-item POST/PATCH payloads must include `sourceItemId` and ship an item type-ahead (`ItemPickerField`), or mobile-created sales silently fall into the top-products "Uncatalogued / other" bucket (no error, totals still tie out).
- **Mobile runs in Expo Go, not a native build** — `expo start` serves JS over Metro to the installed Expo Go app; do not `expo run:android` (triggers a Gradle build that crashes on a removed `JvmVendorSpec`). The ref-gated once-only bootstrap pattern (M3) applies to any multi-fetch bootstrap.

---

## Phase 10 — Production hardening + open-core seams

Phases 0–9 delivered the product; Phase 10 makes it production-ready and adds the
extension seams a downstream/managed deployment plugs into. This is all **public-repo,
self-host-first** work — the community build stays fully functional, because every seam
ships a default that keeps everything on. *(The managed layer that fills those seams is
maintained out-of-repo; nothing of it lands here.)*

**Production hardening** (self-host and cloud both benefit):
- **Object storage in the prod compose** — receipts need a durable home (local-FS driver
  wired; S3/R2 documented for multi-node).
- **Managed-Postgres compatibility** — make the read-only (BYPASSRLS) staff role
  optional/skippable so migrations apply on a no-superuser managed PG; direct-vs-pooled
  connection split for pg-boss; a deliberate migrate-on-boot-vs-explicit-step choice.
- **Backups + restore runbook**; confirm error tracking (Sentry/GlitchTip) reports in
  prod; **email domain auth** (SPF/DKIM) so invoice/invite mail delivers.

**Open-core seams** (interfaces + community defaults, all in this repo):
- A **capability/entitlement provider** interface, injected through the existing
  `createApp(deps)` factory, with a community default that returns "unlocked" — self-host
  behavior unchanged.
- **Per-account LLM credential resolution** in `packages/ai` — accept an injected
  credential per call instead of a single global env key (self-host injects the env key).
- An **account-created hook** and an **admin mount-point** — no-op / unmounted by default.
- Move the staff read-only role into its **own optional migration**, out of the core
  schema, so core migrations apply cleanly everywhere.

Sequence hardening ahead of the seams (hardening gates any real deploy; the seams are
additive). Slices TBD when the phase starts.

---

## Post-MVP polish — Editable email templates (+ branded email shell)

Pre-launch trust + commercialization polish, **not a numbered phase** (so no Phase-overview
row — tracked here because it grew past a status-line mention). The customer-facing emails
(invoice / estimate / statement) went from bare `<p>` + raw-link bodies to a branded,
inline-styled shell, then became **per-company editable** — a business customizes the
subject + message with `{{placeholders}}` while the branded chrome stays server-owned.
Platform emails (verification, invitation) are intentionally **not** editable. Built
api → web → mobile, mirroring the MVP slice discipline.

**Design (locked):** edit structured plain-text fields rendered **into** the fixed shell —
never user-authored HTML to recipients, so escaping stays ours; **defaults live in code**, a
DB row is only an override (an empty `email_templates` table is the correct zero-config
state — self-host needs no seeding); the send path resolves override-or-default by
`(company_id, type)`; a per-type placeholder whitelist in `@thalermark/validation` that the
editor and the API validate identically; the fixed chrome (CTA button, statement ledger
table, "valid until" line, reply-to note, footer) is not editable.

| Slice | PR | What landed |
|---|---|---|
| De-spam shell | #251 | Shared branded email shell (`apps/api/src/lib/email-layout.ts`): table-based, inline-styled, one CTA, hidden preheader, no images (deliverability-safe). All five recipient-facing emails routed through it with warmer copy — customer emails lead with the sending company's name + a subtle "Sent with Thalermark" footer; platform emails lead with Thalermark. |
| A — backend | #252 | `email_templates` table (account+company, type, subject, body, `unique(company_id,type)`) + RLS; validation (types, placeholder registry, update schema, `unknownPlaceholders`); `DEFAULT_TEMPLATES` + `applyTemplate`/`renderTemplate` + `resolveEmailTemplate`; builders made template-driven (invoice/statement refactored, estimate extracted to `lib/estimate-email.ts`) with the resolver wired into the invoice / estimate / statement / recurring send paths; `GET` / `PUT` / `DELETE` / `POST :type/preview` endpoints (settings:manage for writes, GET ungated). Tests: integration (incl. override-changes-the-sent-email) + unit + an RLS-isolation block. |
| B — web editor | #253 | `/settings/email` lists the 3 templates (Default/Customized badge) + Edit; new `/settings/email/[type]` editor (subject + message, placeholder reference, Save / Preview / Reset). Preview renders the candidate template through the API preview endpoint (real builders + sample data) into a sandboxed iframe. Plain SvelteKit form actions; under the settings:manage Email tab. |
| B.1 — web view | #254 | A **View** on each template row renders the *effective* template into an inline sandboxed iframe (peek without editing); toggles to **Close** while open (`?/view` ↔ `?/close`). |
| C — mobile | #255 | Native parity: `more/email` lists the 3 templates with **View/Close** (inline preview) + **Edit**; `more/email/[type]` editor (subject/body, placeholder reference, Save/Preview/Reset). Gated by the More menu's `useMay('settings:manage')`. |

**Realized differs from plan:** mobile carries no `react-native-webview`, so its View/Preview
shows the email's **text** rendering (the preview endpoint returns it) rather than the HTML
iframe the web uses — same content, no new native dependency.

---

## Post-MVP polish — Invoice & estimate "from" block

Pre-launch presentation polish, **not a numbered phase** (so no Phase-overview row — same
deviation as the email-templates wrap above). The public invoice / estimate's sender block is
the recipient's first impression of the user's business, so the operator now controls what it
shows. Two levers per document type: a **new business email** (distinct from the reply-to
address — reply-to only sets a mail header), and **per-field "show on the document" toggles**
for address / phone / email. Built api → web → mobile per the usual slice discipline.

**Design (locked, user-confirmed):** a company-level **default** per field, **separate by
document type** — `show_{address,phone,email}_on_invoice` and `…_on_estimate` on `companies`
(a business may show contact on invoices but not estimates, or vice versa); `business_email` is
shared, gated independently per type. Each invoice / estimate snapshots its own
`show_{address,phone,email}` flags from the company default at create, then they're editable
while it's a draft, so a later settings change never rewrites an already-issued document. The
public view **gates server-side** — a hidden field never reaches the recipient's page, not
merely hidden client-side. All flags default **true** (preserves the prior always-show
behavior; the new email defaults on too). Estimate → invoice convert keeps seeding from the
*invoice* defaults (separate document type). The estimate "from" block was **built from
scratch** — the public estimate previously rendered only the company name.

| Slice | PR | What landed |
|---|---|---|
| A — invoice api | #257 | `companies` gains `business_email` + `show_{address,phone,email}_on_invoice`; `invoices` gains `show_{address,phone,email}` overrides (migration 0045). Company read/create/update carry the new fields; invoice create seeds flags from company defaults (client override wins), edit persists, duplicate carries source flags, estimate-convert + the recurring sweeper seed from company defaults; the public invoice GET gates the three contact fields + returns `companyEmail`. |
| B — invoice web | #258 | Settings → Business gains the Email field + a "Show on invoices" checkbox per field; invoice new/edit forms get a "Your details on this invoice" checkbox section (new seeds from company defaults, edit from the invoice's flags); the public invoice view renders the business email. |
| A2 — estimate api | #259 | `companies` gains `show_{address,phone,email}_on_estimate`; `estimates` gains the override flags (migration 0046). Estimate create/edit/duplicate wired like invoices; the public estimate GET returns + gates `companyAddress/Phone/Email` (the block was name-only before). |
| B2 — estimate web | #260 | Settings → Business gains a second "Show on estimates" checkbox per field (6 total); estimate new/edit forms get the toggle section; the public estimate view (`/e/[token]`) gets a **new** "From" block. |
| Logo | #261 | The public estimate header now renders the company logo (fresh signed URL per load), matching the public invoice — no toggle. |
| C — mobile | #262 | Native parity: `more/business` gains the email field + the 6 checkboxes; the invoice + estimate new/edit forms get the toggle section. New shared `components/Checkbox.tsx`; `pickActiveCompany` made generic so callers keep the full hc-typed company. No public render on mobile. |

**Note:** item 2 of the original polish pair (de-spam the outbound emails) was absorbed by the
*editable email templates* feature above, not this one.

---

## Post-MVP polish — Telemetry wiring (consent + both emit paths)

Pre-launch trust work, **not a numbered phase** (no Phase-overview row, same deviation as the
sections above). The telemetry **module** shipped back in Phase 2, but stayed **inert** — only
one event ever emitted (`expense_categorised`) and no way for an account to opt in. Two slices
made it live end-to-end. **Transmission stays env-gated OFF:** events stage locally in
`telemetry_events` and nothing leaves the host until a deployment sets `TELEMETRY_TRANSPORT_ENABLED`
+ `TELEMETRY_ENDPOINT_URL`, which needs a **receiver service maintained out-of-repo** (not built).

**Design (locked):** opt-in is account-wide (`accounts.telemetry_enabled` + `telemetry_install_id`,
per-account, rotated on opt-in) with a `telemetry_decided_at` stamp so the first-run prompt fires
exactly once; `TELEMETRY_DISABLED` is a hard kill (emit no-ops, prompt hidden, opt-in collapsed).
`emit()` is opt-in-gated, so every call is a safe no-op until consent. Server-side events emit
inline at the mutation; client-only events POST to an ingest endpoint that re-uses the same gate.
**The data is never exposed to the end user** — the public repo is sender-only (no read endpoint
for staged events); the viewing/analytics surface is SaaS/commercial (the receiver + an internal
dashboard), with only aggregate, anonymous reports published publicly as a trust signal.

| Slice | PR | What landed |
|---|---|---|
| 1 — consent + server emit | #280 | `accounts.telemetry_decided_at` (migration 0051); `enable/disableTelemetry` stamp it; `isTelemetryDisabled()` + an `emit()` hard-no-op guard. `GET`/`PATCH /api/account/telemetry` (PATCH = settings:manage). Server-side `emit()` at invoice create / mark-sent (link) / `/send` first-email / mark-paid, expense create, customer / company / estimate create, estimate convert. Web: Settings → Privacy toggle + first-run consent banner (settings:manage) in the (app) layout; mobile: `more/privacy` + first-run card on Home. TELEMETRY.md reconciled (per-account install_id, decide-once, `TELEMETRY_DISABLED` honored). |
| 2 — client ingest + report_viewed | #281 | `POST /api/telemetry/ingest` (any member; `telemetryIngestSchema`-validated batch; opt-in-gated emit) + relaxed `GET` to any member (the emitter needs `enabled`). `report_viewed` enum corrected to the real `/reports/<slug>` set. Client emitters (`$lib/telemetry` web, `lib/telemetry` mobile) buffer + debounce + flush on tab-hide / app-background; web posts via a same-origin `/telemetry-ingest` proxy (browser can't stamp x-account-id), mobile calls the route directly. `report_viewed` wired from one place per platform (web `reports/+layout.svelte`; mobile shared `useTrackReportView` in `ReportScaffold` + top-products). |

**Deferred (no UI surface yet):** session / performance / flow-abandonment + the AI
view/dismiss/query/suggestion events — each a one-liner on the ingest pipeline once its surface
exists.

---

## Post-MVP polish — Contacts unification (customers → contacts) + expense vendor link

A v1.2-class, cross-cutting change, **not a numbered phase** (no Phase-overview row, same
deviation as the sections above). Today the two halves of a business relationship were modelled
inconsistently — **sell-to** lived in a real `customers` table, **buy-from** was just
`expenses.merchant` free text with no entity. For trades/freelancers the same business is often
both, so this unifies them into one **`contacts`** entity (the Xero model: one record that can act
as customer and/or supplier) and lays the **accounts-payable seam** — without building AP (bills,
AP control account, 1099) here. Canonical design: `spikes/CONTACTS-AND-AP.md`.

Shipped on the **`contacts-rename` integration branch** as per-slice commits, db → validation →
api → web → mobile → wrap, squash-merged to `main` as a single PR (so `main` never saw partial
state). Because it's one squash-merge, the table below maps slices to what landed rather than to
per-slice PR numbers.

**Design (locked, user-confirmed):**
- **Full rename `customers` → `contacts`** (table, FK columns, API, validation, UI,
  `customers:write` → `contacts:write`). The cheaper "just add `is_vendor`/`is_customer` flags to
  the `customers` table and skip the rename" was **rejected** — a self-hoster inspecting the schema
  must not find `customers.is_vendor` and no `vendors` table. A self-documenting schema wins the
  churn. Role flags `is_customer` (default true) / `is_vendor` (default false) added.
- **One on-screen "Vendor" field** for the expense buy-from side (the "Merchant" wording leaves the
  UI). Behind it: the kept `merchant` text is the always-present **display name**; a new nullable
  `vendor_contact_id` is the optional **structured link**; `vendor_review` is a stored status. This
  resolved a user objection to a visible two-field (merchant + vendor) model — the two are never
  shown separately. Linking **mirrors the contact's name into `merchant`** (server-authoritative)
  and **flips `contacts.is_vendor = true`**, so an existing customer becomes a vendor too — the
  buy-from half of the total-relationship view.
- **Receipt OCR is scan-and-forget + a review flag**, additive on the existing extract-and-prefill
  capture (not a rework): a receipt uploaded with no vendor linked sets `vendor_review='needs_review'`;
  it clears on link-or-dismiss. A "Needs review" list filter is where a human links an existing
  vendor, creates one inline, or **dismisses** (one-off — clears the flag, creates no contact). On
  edit, the flag only moves when the vendor field is touched, so an unrelated edit never resurrects a
  dismissed flag.
- **Two-step migration.** Now: hand-written `0053` (`RENAME` table — RLS/FKs/indexes follow
  automatically — + column renames + role flags + audit `entity_type` update) and `0054` (the
  additive `vendor_contact_id` / `vendor_review` + indexes). Squawk renaming + add-FK rules
  suppressed inline (pre-alpha, no populated prod tables). Deferred to its own pre-release PR: reset
  the migration *history* to a clean baseline (so `contacts` is born named correctly and the file
  count collapses); until then `drizzle-kit generate` stays off and migrations are hand-written.

| Slice | What landed |
|---|---|
| 1 — db | `customers` → `contacts` (table + indexes + RLS policy) + `is_customer` / `is_vendor`; FK columns `invoices`/`estimates`/`recurring_invoices` `customer_id` → `contact_id`, `expenses` `customer_id` → `customer_contact_id`; `audit_events.entity_type` `customer` → `contact`. Hand-written `0053` (`RENAME`, not drop+create). |
| 2 — validation | `customer.ts` → `contact.ts` (`contactCreate`/`UpdateSchema` + optional `isCustomer`/`isVendor`); `customers:write` → `contacts:write`; wire fields renamed; `contactImportSchema`. |
| 3 — api | `/api/customers*` → `/api/contacts*`; new tested `?role=customer\|vendor` filter + flags on create; audit `entityType:'contact'` on the write **and** the feed read side; `customer_not_found` → `contact_not_found`. Kept where cheap to limit client churn: `customerName` list field, `customer_company_mismatch`, the `sales-by-customer` report, and the customer-statement lib (a document concept). |
| 4 — web | Route dir `(app)/customers` → `contacts`, nav, hc `api.customers` → `api.contacts`, capability, `customer-dupes.ts` → `contact-dupes.ts`, invoice-list query param. **Pure rename** (user chose this; vendor-role UI deferred to slice 6). Statement page reverted to read the API's kept `customer` object. svelte-check + 18 tests green. |
| 5 — mobile | Mirror of slice 4; `CustomerFilterField.tsx` → `ContactFilterField.tsx`; the inline-create local error-key `customer_<field>` → `contact_<field>`. Expo typedRoutes regenerated to `/contacts`. tsc green. |
| 6 — expense vendor link + OCR needs-review | The buy-from feature, end-to-end. **6a db:** `0054` — `expenses.vendor_contact_id` (→ `contacts`, restrict) + `vendor_review` + a partial needs-review index. **6b validation:** `vendorContactId` on the expense schema. **6c api:** `resolveVendorLink()` (validate + name-mirror + `is_vendor` flip), the `vendor_review` lifecycle, `POST /api/expenses/:id/dismiss-review`, `GET /api/expenses?needsReview=true`. **6d web:** `VendorPicker.svelte` + `/contacts/search` proxy + inline "add vendor", Merchant→Vendor relabel, needs-review filter + per-row badge + detail dismiss. **6e mobile:** `VendorField.tsx` + `resolveVendor()`, the filter chip + badge, detail banner + dismiss. 255 db / 135 validation / 488 api tests; web + mobile typecheck green. |
| 7 — wrap | This SCAFFOLDING record. |

**Explicitly deferred (the bills/AP feature, not this work):** bills / accounts-payable tables, an
AP control account in the COA seed, 1099 / W-9 vendor tax fields, vendor payment terms, and any
forced dedup of historical `merchant` strings. The two role flags + `vendor_contact_id` are the
only forward-compat baked in; a future `bills` table FKs `contacts(id)` where `is_vendor = true`.

---

## Post-MVP polish — other shipped tracks (since Phase 9)

Between the Phase-9 mobile catch-up and now, work continued as **non-phase tracks** (auth, roles,
onboarding, commercialization groundwork, presentation) rather than numbered phases. Each shipped
api → web → mobile per the usual slice discipline; full detail lives in the PRs. The detailed
write-ups above (editable email templates, from-block, telemetry, contacts unification) are the
tracks that grew their own section; the rest are cataloged here.

| Track | PRs | What shipped |
|---|---|---|
| Keyset pagination | #194–#196 | Cursor pagination across the lists (api/web/mobile); page size 25 lists / 50 activity feed. |
| Report CSV + GL export | #237 | Client-side CSV export on every report page + the GL / trial-balance export surfaced in a `/reports/general-ledger` page (see the L4 row). |
| Workspace-membership management | #213–#219 | Invite accept/decline, a durable **owner** concept (`memberships.role`, owner protected), member remove/leave, and the account→**Workspace** UI rename. |
| Granular workspace roles (v1.1 layer A) | #220–#224 | 5-role capability model (owner/admin/member/accountant/viewer) enforced app-wide via `locals.role` + `may()` / `useMay()`; team role management on web + mobile. |
| Onboarding welcome wizard | #228, #235 | 3-step `/welcome` wizard replacing the old `/setup` business-type gate (web #228, mobile #235); first-run gate keyed on the active company's business type. |
| Multi-company create + switch | #229, #230, #234 | `POST /api/companies` (settings:manage) + company switcher / active-company persistence on web (#230) and mobile (#234). **RLS pins account only — every company-scoped read must pass companyId.** |
| Social sign-in + email verification | #231–#236 | Better Auth Google/Facebook/X providers (web #231, mobile #236 via `@better-auth/expo`) + account linking; email verification gated on a configured mailer + disposable-email blocking (#232/#233). |
| Web design system | #241–#247 | Whole web app moved onto semantic CSS-var role tokens + primitives (`.btn` / `.field` / `.callout` / …), matching the landing template; dark-mode-ready (a `.dark{}` remap, no markup change). |
| Per-item tax (v1.1) | #264–#269 | Company tax policies + per-item `taxable` flag + per-line tax snapshot; header tax derived (ledger untouched). Migrations 0047/0048; mobile recurring-editor parity closed #269. |
| Line-item product/service type | #270–#273 | A `type` enum on items routes the hidden-ledger revenue split (Service 4000 / Product 4100), derived at posting; migration 0049. |
| Password reset | #274–#276 | Better Auth `sendResetPassword`; request on mobile, complete on web; social-only set-password exit; sessions revoked on reset. |
| Login brute-force backoff | #277 | Better Auth built-in rate limiting, DB-backed (`auth_rate_limit`, migration 0050), per-path rules, prod-on via `RATE_LIMIT_ENABLED`. |
| Wrong-method sign-in rescue | #278, #279 | Names the user's existing provider(s) + a "Last used" badge so a Google-first user who tries a password isn't dead-ended (web #278, mobile #279). |

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

**Status (2026-06-09):** every item in the list below has shipped on **web** through Phase 8 (slices 8.1–8.15 + L1–L4 + R1–R4 + I1–I5, the last being the items / products & services catalog added to scope 2026-06-07), and the **mobile app has caught up to feature parity in Phase 9** (slices M1–M11f). The full locked MVP scope is now feature-complete on both clients; remaining MVP work is **polish + ship**.

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
   - Items / products & services catalog (Slice I — added to scope 2026-06-07; autocomplete + management + top-products report)
3. **Polish + ship**
