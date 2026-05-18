# Scaffolding Plan

**Status:** Phases 0 and 1 shipped (2026-05-17). Phase 2 (telemetry) is up next.
**Reads:** Assumes you've read PROJECT.md and TECH-STACK.md.

The shape of work between "all decisions locked" and "writing actual MVP features." Eight phases, roughly sequential — each builds on the previous one. None of the actual MVP feature code is in here; this is just the foundation.

---

## Phase overview

| Phase | What gets built | Why this order | Status |
|---|---|---|---|
| **0** | Repo skeleton + tooling | Everything else lives in here | ✅ Shipped |
| **1** | Database foundation + RLS | Every other layer assumes the DB is right | ✅ Shipped (slices 1.1–1.6, PRs #11–#19) |
| **2** | Telemetry module | Trust signal; build *before* features so the patterns are established | ⬅ Next |
| **3** | API foundation (Hono + Better Auth) | Web and mobile both need it to do anything | — |
| **4** | Shared packages (validation, AI, location, brand) | Web/mobile/api all consume them | — |
| **5** | Web app shell (SvelteKit) | Auth flows, layout, empty home | — |
| **6** | Mobile app shell (Expo) | Same shape, native shell | — |
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
