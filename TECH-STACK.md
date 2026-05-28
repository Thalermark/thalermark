# Tech Stack — Decision Document

**Status:** Fully locked — all technical and licensing decisions made. Ready to scaffold.  
**Last updated:** May 2026

---

## Context

We are building an open source, AI-first accounting tool for freelancers and trades people. This document captures the locked decisions, the constraints behind them, and what's still open.

---

## Locked Decisions

| Layer | Pick | Why |
|---|---|---|
| **Database** | PostgreSQL 17, single DB, single schema | ACID for the hidden double-entry ledger (see PROJECT.md "How the books work"), JSONB for documents, pgvector for embeddings, one datastore to run. PG 17 over 18 — drizzle-kit shipping PG 18 fixes flagged it as too fresh for financial software; revisit in 6-12 months. |
| **Multitenancy** | Row-level via Postgres RLS, `account_id` + `company_id` | DB-enforced isolation, fintech standard, same code path SH and SaaS |
| **Web frontend** | SvelteKit | Engineer preference, lighter than Next, excellent DX, SSR + client hydration built in |
| **Mobile** | React Native + Expo | One codebase iOS+Android, native camera for receipts, Expo EAS removes native build pain |
| **Backend language** | TypeScript on Node 24 LTS | Shared types with web + mobile, large contributor pool, common host support, longer LTS runway (until April 2028) |
| **Backend framework** | Hono (running on Node via `@hono/node-server`) | Modern, type-safe RPC client, Zod-native, runtime-agnostic if we ever leave Node |
| **ORM** | Drizzle | Clean RLS interplay (transaction-scoped `SET LOCAL` is natural), first-class pgvector, light runtime, SQL-transparent |
| **Auth** | Better Auth | Cookies (web) + bearer tokens (mobile) in one library, official Drizzle + Hono adapters, organizations plugin maps onto `account_id`/`company_id`, self-hostable |
| **LLM default** | Anthropic Claude (Sonnet 4.6 for reasoning, Haiku 4.5 for fast/cheap) | Strong structured reasoning over user data, careful hedged tone matches "awareness not advice" framing, excellent SDK |
| **LLM abstraction** | Vercel AI SDK | Thin provider-agnostic seam — Anthropic / OpenAI / Ollama swap via config, uniform streaming + tool use + structured outputs |
| **BYOK** | Self-host: yes (env-var configurable); SaaS Pro: post-MVP | Self-host story requires it; privacy-sensitive users (accountants, NDA-bound) get real path via local Ollama; SaaS keeps curated experience with our key + quotas |
| **API contract** | Hono RPC | Free with Hono, end-to-end types from server to web + mobile, zero extra ceremony |
| **Validation** | Zod | Standard; pairs with `@hono/zod-validator` and `drizzle-zod` for shared schemas in `packages/validation/` |
| **Monorepo tool** | Turborepo + pnpm workspaces | Most popular, simplest, smart build orchestration + free remote cache for OSS via Vercel |
| **Package manager** | pnpm | Best monorepo support, smaller `node_modules`, fast, hard-linking saves disk |
| **Linter / formatter** | Biome | One Rust-fast tool replaces ESLint + Prettier |
| **Test runner** | Vitest | Jest-compatible API, fast, monorepo-friendly |
| **CI** | GitHub Actions | Free for public repos, where OSS contributors already are |
| **Reverse proxy** | Caddy | Auto TLS via Let's Encrypt out of the box, fits the one-`docker compose up` promise |
| **Background jobs** | pg-boss | Runs on Postgres — no new service in the compose file |
| **Email** | Resend (SaaS) + SMTP via nodemailer (self-host) | Resend has cleanest DX + transactional/marketing in one; self-hosters configure their own SMTP via env vars |
| **Object storage** | S3-compatible interface — R2 in SaaS, MinIO in dev compose, local FS adapter for tiny self-host | One code path via `@aws-sdk/client-s3`, swap the endpoint via config |
| **PDF generation** | Playwright (HTML → PDF) | Templates in HTML/CSS so design can iterate; same chromium runs E2E tests. ~300MB image weight is the trade-off. |
| **Receipt OCR** | Two-layer: capture (core, all tiers) + extraction (Pro+/BYOK, vision LLM via Vercel AI SDK) | Image is always saved (IRS-compliant in every tier). AI auto-fills merchant/total/date/category as a premium feature. No separate vendor for MVP; same `LLM_API_KEY` powers OCR and insights. Vendor (Veryfi/Mindee) is a future Pro upsell as fallback for low-confidence extractions. |
| **License** | AGPL v3 + Commercial Dual | OSI-approved real open source preserves trust signal; AGPL closes the SaaS strip-mining loophole; commercial dual enables revenue from white-label accountants, agencies, and embedders who can't AGPL. Closest-fit precedent: Cal.com, Mattermost, Plane. CLA via CLA Assistant on GitHub. |
| **Location / address autocomplete** | Mapbox (default), OpenStreetMap Nominatim (self-host fallback), behind portable `AddressAutocompleteProvider` interface | ~30× cheaper than Google Places, ~100k free sessions/mo covers thousands of users; same swap-via-config pattern as LLM provider; Google adapter is a 1-2 day swap if ever needed |
| **CSS / UI styling** | Tailwind CSS on web, NativeWind on mobile, shared brand tokens from `packages/brand` | Same mental model (utility classes) across web and mobile; brand tokens defined once and consumed by both; Tamagui rejected — unified components are powerful but consistency-via-same-classnames wins for a solo developer |

The web and mobile are intentionally separate codebases sharing a backend, with shared TypeScript packages for API contract types, Zod schemas, and brand constants.

---

## Hard Constraints

These are non-negotiable:

- **Self-hosting must be simple** — ideally a single `docker compose up`. Trades people and small agencies should be able to run this without a DevOps background
- **AI integration must be clean** — the AI layer is core, not bolted on. The stack needs to support streaming responses, embeddings, and LLM API calls naturally
- **Mobile first** — the primary audience is never at a desk. The frontend must be excellent on mobile
- **PostgreSQL** — locked. Single database, single schema, row-level tenancy enforced by Postgres RLS. JSONB for flexible payloads (receipt OCR, telemetry). pgvector for AI embeddings. No second datastore in MVP.
- **Contributor friendly** — open source means community contributors. Common languages lower the barrier to contribution

---

## Soft Preferences

These matter but are negotiable:

- Monorepo preferred — keeps everything in one place for a small team
- TypeScript preferred — type safety across the stack reduces bugs in financial software
- Minimal external dependencies — each dependency is a security surface and a maintenance burden

---

## Mobile Strategy — Decided

**React Native + Expo.** One TypeScript codebase for iOS and Android. Expo EAS for builds. Native camera for receipt capture, native push for payment notifications, native lock-screen presence. Web is a separate SvelteKit app for the accountant tier and any desk-bound workflows; mobile is the primary experience for trades users.

Considered and rejected:
- **PWA** — iOS push remains unreliable, native camera UX is noticeably worse, lock-screen presence is weak
- **Web responsive only** — fails the "never at a desk" audience
- **Capacitor (Svelte → mobile)** — works, but pulls a single codebase across two very different UX paradigms; separate native shell is cleaner

---

## AI Layer Considerations

The AI layer needs to support:

- Natural language queries against user's own financial data
- Anomaly detection on transactions
- Cash flow forecasting
- Invoice intelligence (late payer detection)
- Tax estimation
- Expense categorisation suggestions

This implies:
- LLM API integration (likely Anthropic Claude or OpenAI)
- RAG or function calling to query user data safely
- Streaming responses for good UX
- Clear separation between AI module and core accounting logic

---

## Remaining Open Decisions

All technical and licensing decisions are locked. Next steps are scaffolding and the formal MVP feature list.

---

## Multi-tenancy Architecture — Decided

**Row-level tenancy enforced by Postgres RLS (Row-Level Security).** This is the modern fintech/SaaS standard (Stripe, Mercury, Brex, Ramp, Pilot, Bench, Puzzle, FreshBooks, Wave all use this pattern).

Two layers of isolation in the same model:
- `account_id` — the paying customer / workspace. SaaS isolates between accounts. Self-hosted has one row in the accounts table; same code path, no special case.
- `company_id` — multi-company *within* an account. An accountant managing 5 trades clients, or a freelancer with two side businesses, both fit here.

Why this over schema-per-tenant:
- RLS is enforced *by Postgres*, not by the ORM. Same hard guarantee as schemas without the migration pain.
- Schema-per-tenant ceilings around 5–10k schemas due to system catalog bloat. Row-level has no realistic ceiling.
- Single migration path. Single connection pool. Single backup. Operationally identical for SH and SaaS.
- Self-hosted ships with the same code, just always evaluating to one account. Zero divergence between deploys.

Considered and rejected:
- **Schema-per-tenant** — legacy default. Migration choreography is a tax we don't need to pay; SH gets harder for no isolation gain over RLS.
- **Database-per-tenant** — enterprise pattern, overkill until we have a contractually-isolated tier (post-MVP, if ever).
- **Row-level discipline only (no RLS)** — the dangerous version. App-layer enforcement is one bad query away from a leak. Always pair with RLS.

Operational layers that wrap the model differ between deploys (PgBouncer, replicas, S3 vs local FS for receipts, per-account encryption) but the data model is one thing.

---

## Self-hosting Requirements

The self-hosted install must:

- Run with a single `docker compose up`
- Require no external services beyond what's in the compose file
- Include PostgreSQL, the app server, and a reverse proxy
- Support environment variable configuration for all secrets
- Ship with a first-run setup wizard
- Support upgrade via `docker compose pull && docker compose up`

---

## Next Step

Have the tech stack conversation with Claude Code. Reference this document and PROJECT.md for full context. The decision should be made before any scaffolding begins.
