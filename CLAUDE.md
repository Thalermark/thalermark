# CLAUDE.md — Project orientation

A fast orientation for anyone (human or AI assistant) joining the Thalermark codebase. Read this first, then dive into PROJECT.md, TECH-STACK.md, TELEMETRY.md, and SCAFFOLDING.md for full detail.

This file is the conventional landing page for Claude Code and other AI dev tools that auto-load `CLAUDE.md`/`AGENTS.md`. It's also a perfectly good 5-minute orientation for human contributors.

---

## What We're Building

**Thalermark** — an open source, AI-first accounting tool for freelancers and trades people. Landscapers, dog sitters, power washers, independent contractors. Think QuickBooks but built for people who hate accounting, not people who love it.

**The core insight:** users don't want accounting. They want answers. The AI layer surfaces plain-English insights rather than asking users to learn accounting concepts.

**The brand:** Thalermark draws on two ancient currency words. The Thaler was the 16th century silver coin that became the root of the word "dollar." The mark was the stamp pressed into a coin to certify its authenticity. Together: every transaction, authenticated.

Domain: `thalermark.com` (registered).

---

## Where We Are

Business requirements complete. Tech stack locked. Phase 0 (repo skeleton + tooling) complete.

Next: Phase 1 — database foundation + RLS policies in `packages/db/`. See SCAFFOLDING.md for the full 0→7 phase plan that lands us at the first MVP feature.

---

## Name

**Thalermark.** Locked. `thalermark.com` registered.

- *Thaler* = the silver coin that became the etymological root of "dollar"
- *Mark* = a monetary unit AND the stamp of authenticity on a coin
- Together = "the mark of the Thaler" — stamp of authenticity on the dollar's ancestor

Pronunciation: THAH-ler-mark (three syllables, stress on first).

This is the official product name. Use it everywhere.

---

## Tech Stack

**Locked so far:**
- **Database:** PostgreSQL 17 — single DB, single schema, row-level tenancy via RLS (`account_id` + `company_id`). JSONB for payloads, pgvector for embeddings. No second datastore in MVP. UUIDv7 IDs generated app-side via `uuid` npm package.
- **Web frontend:** SvelteKit (TypeScript) + Tailwind CSS
- **Mobile:** React Native + Expo (TypeScript) + NativeWind, separate codebase, shared types with backend, shared brand tokens from `packages/brand`
- **Backend language:** TypeScript on Node 24 LTS
- **Backend framework:** Hono (via `@hono/node-server`)
- **ORM:** Drizzle (clean RLS interplay, first-class pgvector, SQL-transparent)
- **Auth:** Better Auth (cookies for web, bearer tokens for mobile, organizations plugin for account/company memberships, self-hosted in our DB)
- **LLM:** Anthropic Claude default (Sonnet 4.6 + Haiku 4.5) via Vercel AI SDK; BYOK on self-host from day one (env-var: Anthropic, OpenAI, or local Ollama)
- **API contract:** Hono RPC (end-to-end types from server to web + mobile)
- **Validation:** Zod (shared schemas in `packages/validation/`)
- **Repo shape:** monorepo with `apps/` (web, mobile, api) + `packages/` for shared types, validation schemas, brand constants
- **Monorepo tooling:** Turborepo + pnpm workspaces
- **Linter / formatter:** Biome (single tool, replaces ESLint + Prettier)
- **Test runner:** Vitest
- **CI:** GitHub Actions
- **Reverse proxy:** Caddy (auto TLS)
- **Background jobs:** pg-boss (Postgres-backed, no new service)
- **Email:** Resend (SaaS), SMTP via nodemailer (self-host)
- **Object storage:** S3-compatible interface (R2 SaaS, MinIO dev, local FS adapter for self-host)
- **PDF generation:** Playwright (HTML → PDF; same chromium runs E2E tests)
- **Receipt OCR:** capture (core, all tiers — image always saved) + extraction (Pro+/BYOK, vision LLM auto-fills merchant/total/date/category). Same `LLM_API_KEY` powers OCR and insights; no separate vendor for MVP.
- **License:** AGPL v3 + Commercial Dual. CLA via CLA Assistant on GitHub. Commercial license available for white-label / proprietary embedders who can't AGPL.

**All technical and licensing decisions are locked.** See TECH-STACK.md for the full table.

Key constraints behind the picks:
- Self-hosting via single `docker compose up`
- AI-first — LLM integration is core, not a feature
- Mobile first — primary audience lives on their phone
- Contributor-friendly — TypeScript across the stack lowers the barrier

---

## How the books work

**Hidden double-entry.** Thalermark keeps a real general ledger under the hood — every invoice/payment/expense state change posts balanced journal entries against a per-company chart of accounts. Users never see "debit," "credit," or "journal entry." They see invoices, expenses, customers, and answers. See PROJECT.md "How the books work" for the full rationale and TECH-STACK.md "Database" row for the ACID justification.

Business type (sole prop / LLC / partnership / S-corp / C-corp) is picked once at company creation and drives the COA seed. MVP ships the sole-prop seed only; other types fall back until v1.x.

---

## MVP Scope — Keep It Tight

**Locked 2026-05-10.** Full spec in PROJECT.md. No additions without explicit decision.

**Invoicing:** send invoice (mobile-first, <60s), estimates with convert-to-invoice, recurring invoices (auto-generate + email; no card-on-file), duplicate-as-template, public invoice view + Stripe pay link.

**Expenses:** manual entry, receipt capture (all tiers), receipt extraction via vision LLM (Pro+/BYOK).

**Customers:** inline create during invoicing, dupe detection, Mapbox address autocomplete (Nominatim self-host fallback). Must be seamless.

**Account/Companies/Users:** multi-company per account (company switcher, RLS-isolated), multi-user per account (Better Auth orgs plugin, invite by email, all members same role in MVP).

**Audit trail:** append-only `audit_events` table; every mutation logs actor + timestamp + entity + action + before/after diff. Per-entity history tab + account-wide activity feed. Foundational because deferred audit history is lost forever — distinct from telemetry (telemetry is opt-in user data sent to Thalermark; audit is per-user history kept locally).

**Position:** dashboard — in, out, owed, owing.

**AI (Pro+/BYOK):** cash flow nudges, late payer detection, anomaly flagging, expense categorization. *Receipt extraction is also AI-powered.*

**Infrastructure:** telemetry module built first as a trust signal.

**v1.1:** granular roles + per-company permissions, customer opt-in saved card, AI tax readiness (structured), bank feed (Plaid/Teller), natural language queries.

**Deferred:** mileage, time tracking, client portal, bills, auto-charge subscription billing.

Nothing else until MVP is excellent.

---

## AI Layer

Not a chatbot in the corner. Woven into the core:

- Natural language queries against user's own data
- Anomaly flagging
- Cash flow nudges based on history
- Late payer detection
- Tax readiness estimates (US-first, not financial advice)
- Expense categorisation suggestions

LLM: Anthropic Claude default (Sonnet 4.6 for reasoning, Haiku 4.5 for fast/cheap) via Vercel AI SDK. Self-hosters can swap to OpenAI or run local Ollama via env var. BYOK on SaaS Pro is post-MVP.

---

## Folder Structure (Starting Point)

Planned layout. `apps/` and `packages/` are seeded during Phases 1-6 of SCAFFOLDING.md — only the workspace plumbing is live as of Phase 0.

```
/
├── apps/
│   ├── web/          # SvelteKit
│   ├── mobile/       # React Native + Expo
│   └── api/          # Hono backend
├── packages/
│   ├── api-contract/ # Shared Hono RPC types
│   ├── validation/   # Shared Zod schemas (invoice, expense, etc.)
│   ├── db/           # Database schema, migrations, RLS policies
│   ├── ai/           # AI/LLM integration layer
│   ├── telemetry/    # Telemetry module (see TELEMETRY.md)
│   ├── location/     # Address autocomplete provider abstraction
│   └── brand/        # Brand constants (name, colours, copy)
├── docker/
│   ├── docker-compose.yml      # self-host: postgres + caddy + api + web
│   └── docker-compose.dev.yml  # dev: postgres + minio
├── .github/workflows/ci.yml
├── PROJECT.md           # business brief, audience, feature list
├── TECH-STACK.md        # locked technical decisions and why
├── TELEMETRY.md         # opt-in telemetry spec
├── SCAFFOLDING.md       # phase plan, Phase 0 → first MVP feature
├── CONTRIBUTING.md
├── CLA.md               # contributor license agreement
├── LICENSE              # AGPL v3
├── LICENSE-COMMERCIAL.md
└── README.md
```

---

## Monetization Context

No hard paywall at launch. Value ladder:

- Community — free, self-hosted
- Cloud — managed hosting
- Pro — Cloud + AI insights layer
- Accountant — Pro + multi-client workspaces, white label

The AI layer is the premium differentiator. Tier pricing is held off-repo until pre-launch.

---

## Telemetry

Fully specced in TELEMETRY.md. Opt-in, anonymous, auditable, open source. The telemetry module lives at `packages/telemetry/`. Build this early — it's a trust signal for the community.

---

## Compliance

- US-first by default
- 1099 awareness, self-employment tax estimates, quarterly reminders
- Compliance is a pluggable module — not hardcoded
- All AI tax language framed as awareness, never advice

---

## Early Revenue

Before any paywall:
- Paid setup calls (one-time)
- Managed cloud hosting (first recurring)
- Email capture from day one (Resend or Mailchimp)

Launch network: personal contacts inside relevant open-source accounting communities.

---

## Working principles

- **Specs are in PROJECT.md, TECH-STACK.md, TELEMETRY.md, and SCAFFOLDING.md.** This file is a summary, not the source of truth — if the two disagree, the spec docs win.
- **Decisions are locked.** MVP scope, tech stack, and licensing are all locked. Out-of-scope additions need an explicit decision before code.
- **Tight diffs.** Three similar lines beats a premature abstraction. No half-finished implementations, no speculative feature flags.
- **Self-host story is sacred.** Anything added has to run via `docker compose up` with no external dependencies beyond what's in the compose file.
