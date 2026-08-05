# Project Brief

**Status:** Pre-build — business requirements phase complete  
**Last updated:** May 2026

---

## What We're Building

An open source, AI-first accounting tool built for freelancers, gig workers, and trades people — landscapers, dog sitters, power washers, independent contractors. People who are great at their craft and terrible at paperwork. Not because they're not smart, but because every existing tool assumes they want to be their own accountant.

QuickBooks is built for accountants. ERPNext is built for enterprises. Wave is closer but still overwhelming. Nobody has built something genuinely for this audience.

The core insight: **our users don't want accounting. They want answers.**

Standard accounting software asks: *"would you like to create a journal entry?"*  
Ours asks: *"You have 3 unpaid invoices totalling $1,240 — want me to send reminders?"*

---

## How the books work

**Hidden double-entry.** Under the hood, Thalermark keeps a real general ledger — every invoice send, payment received, expense logged, voids, refunds — posted as balanced journal entries against a per-company chart of accounts. Above the hood, users never see "debit," "credit," "journal entry," or "chart of accounts." They see invoices, expenses, customers, and answers.

This matters for two reasons:

1. **Accountants can actually verify the books.** A real GL trial-balances. A flat list of categorized transactions doesn't. Users who hand off to a tax preparer get something their accountant trusts at face value — not a pile to re-categorize.
2. **The growth path is open.** Sole proprietors today; single-member LLCs, partnerships, S-corps tomorrow. All four entity types need the same underlying ledger; only the chart-of-accounts seed and which reports surface change. A single-entry system would foreclose this — single-entry → double-entry migration after launch is lossy, because flat transactions can't reconstruct a journal.

Business type is picked once at company creation (sole prop / single-member LLC / partnership / S-corp / C-corp) in the same wizard as company name and address. That choice seeds the chart of accounts — one per federal return: Schedule C for the two disregarded-entity types, Form 1065 for a partnership, Form 1120-S for an S-corp, Form 1120 for a C-corp. Account *numbers* are identical across all five so the posting layer never varies; what changes is how the owner's stake is named, a handful of entity-specific accounts, and which tax line each account rolls up to. Changing the type later re-maps the chart in place rather than forcing a fresh set of books. The user never has to know the difference.

Tax *worksheets* lag the charts: Schedule C has one, the other three don't yet, and the reports hub says so plainly rather than showing a form that can't be filled.

---

## Name

**Thalermark.** Locked in. Domain `thalermark.com` registered.

**Etymology:**
- *Thaler* — the 16th century silver coin minted from Joachimsthal, the etymological root of the word *dollar*. Spread across Europe and the world as the trusted international currency for centuries
- *Mark* — itself a monetary unit (Deutschmark, English mark) and the stamp of authenticity pressed into a coin to certify its weight and value (mint mark, hallmark)
- Together: "the mark of the Thaler" — the stamp of authenticity on the dollar's ancestor

**Brand story:**
> Every coin once carried a mark — a stamp pressed into the silver to certify its weight, its purity, its trust. Thalermark does the same for your business. Every invoice, every expense, every dollar accounted for and authenticated.

**Pronunciation:** THAH-ler-mark (three syllables, stress on the first)

**Domains to register defensively:**
- ✅ `thalermark.com` — owned
- 🎯 `thalermark.io`
- 🎯 `thalermark.app`
- 🎯 `thalermark.dev`
- 🎯 `thalermark.co`
- 🎯 `thalermark.net`

**GitHub:** `github.com/Thalermark` org created. Main monorepo will be `Thalermark/thalermark` (public, AGPL v3).

---

## Positioning

> A viewport into your books.

AI-first means the software talks to the user, not the other way around. Intelligence is woven into the core interaction model — not a chatbot bolted on the side.

---

## Primary Audience

**Freelancers, gig workers, and trades people:**
- Landscapers, lawn care
- Power washers
- Dog sitters, pet care
- Independent contractors of all kinds
- Anyone making $2k-$10k/month running their own thing

**What they share:**
- Never at a desk — mobile is primary
- No accounting knowledge or desire to learn
- Price sensitive
- Trust word of mouth over marketing
- Need to know three things: what's owed to me, what I spent, did I make money

**Secondary audience (adjacent, not primary):**
- Bookkeepers managing multiple small clients
- Small agencies running it for trades clients

---

## Product Philosophy

- **Answers not accounting** — surface insights in plain English
- **Mobile first** — this customer is between jobs, not at a desk
- **Simple by default, powerful when needed** — don't show complexity until asked
- **Open source** — community builds trust, trust drives adoption
- **AI first** — intelligence in the core, not a feature

---

## Delivery Model

- **SaaS** — managed cloud hosting (primary revenue)
- **On-prem / self-hosted** — open source, free forever

---

## Licensing Model

**AGPL v3 + Commercial Dual.** Code is AGPL v3 by default — anyone running Thalermark must publish their modifications. A separate commercial license is available for white-label accountants, agencies, and embedders whose own products can't be AGPL. Contributors sign a lightweight CLA via CLA Assistant on GitHub so we retain the right to dual-license.

Precedent: Cal.com, Mattermost, Plane all run this exact model.

| Tier | Model |
|---|---|
| Community | AGPL v3, self-hosted, core features |
| Cloud | Managed SaaS hosting |
| Pro | Cloud + AI insights layer, priority support |
| Accountant | Pro + multi-client workspaces, white label, dedicated support |
| Commercial license | One-time / annual fee for embedders who can't AGPL |

---

## Core Features — MVP

**Locked 2026-05-10.** No additions without explicit decision. Subject to user review.

### Invoicing
- **Send an invoice** — mobile-first, end-to-end under 60 seconds
- **Estimates** — same data model as invoice + status (draft / sent / accepted / declined / expired) + expiration date + "convert to invoice" action. Use case: trades user on a doorstep quoting a job from their phone.
- **Invoice duplicate / use-as-template** — one-tap copy of a prior invoice for fast manual recurring
- **Recurring invoices** — auto-generate from a template and email on a schedule (weekly / monthly / annual). Pause, edit, cancel from a recurrence panel. **No card-on-file in MVP** — customer pays each generated invoice via the Stripe link.
- **Public invoice view** — branded page accessed via unique-token link in the email; shows invoice details + "Pay" button. No login required.
- **Stripe payments** — single payment per invoice via the Pay button (Stripe Checkout). No saved cards in MVP.

### Items (Products & Services)
*Added to MVP scope 2026-06-07 — an explicit decision beyond the 2026-05-10 lock.*
- **Reusable catalog** — a per-company list of saved products/services: name (the picker + report label), a longer description that flows into the line, unit price, an optional unit label ("per visit", "per hour", "sq ft"), and a default quantity. Managed at `/settings/items`. **Archive, never hard-delete** — an archived item drops out of the picker but keeps its sales history intact.
- **Line autocomplete** — typing a line on an invoice / estimate / recurring schedule surfaces matching saved items; picking one prefills description + unit price + quantity. The user can always type a fully ad-hoc line instead.
- **Snapshot, not reference** — the stored line *copies* the item's values, so editing or archiving a catalog item never rewrites an already-sent invoice (the line is a frozen historical record). Each line also carries a hidden `source_item_id` pointer back to the catalog item — purely to make reporting possible; the displayed values always come from the snapshot.
- **Top products report** — "what am I selling most," ranked by revenue / count, grouped by source item. A **management/sales lens, deliberately *not* reconciled to the general ledger.** Total sales is a GL/financial-report question (authoritative, complete, tax-aware); top-products is a curated slice of those same line amounts — pre-tax, catalogued lines only, with an explicit "Uncatalogued / other" bucket so product rows + uncatalogued still tie back to GL revenue on a matched basis. Never presented as posted revenue.
- **Out of scope (MVP):** per-line tax (tax stays invoice-level), per-item COA / category mapping (revenue still posts to the single Sales account), SKU / inventory / stock counts, cost tracking, images. Web-first; mobile inherits in the catch-up phase.

### Expenses
- **Track an expense** — manual entry form, mobile-first
- **Receipt capture (image)** — snap or upload; saved to storage in every tier (IRS-compliant baseline)
- **Receipt extraction (AI)** — Pro+ / BYOK: vision LLM auto-fills merchant, total, date, tax, category

### Customers
- **Customer management** — inline create during invoicing (no page navigation), dupe detection (fuzzy name + strong identifier match), address autocomplete via Google Places (optional — no key ⇒ manual entry). Must be seamless; this is the make-or-break interaction.

### Account, Companies, Users
- **Multi-company per account** — one account can hold multiple companies (a freelancer with side hustles, an accountant managing multiple businesses for themselves). Company switcher in nav; data isolated via RLS at the database level.
- **Multi-user per account** — one account can have multiple members (family member helping with invoices, partner doing books). Memberships are our own `accounts`/`companies`/`memberships` tables — the Better Auth organizations plugin is **not** used (tenancy is our domain). Invite by email via Resend; invitee clicks link, signs up or signs in, joins the account.
- **Workspace roles** — the 5-role capability model shipped, with member removal + ownership transfer. *(Supersedes the original "single role in MVP".)* Per-company permissions remain a v1.1 item.

### Audit Trail
- **Append-only event log** — every mutation (create / update / delete / send / void / pay / accept / decline) writes a record to an `audit_events` table. Fields: actor, timestamp, entity, action, before/after diff (JSONB), IP, user agent. RLS-scoped to account/company like all data.
- **Per-entity history tab** — invoice, expense, customer, member pages show their own change history.
- **Account activity feed** — a single "Activity" page filterable by user / date / entity type.
- **No tamper-evident cryptographic chaining in MVP** — basic append-only is enough; cryptographic chains are post-MVP at the earliest, possibly never.
- **Why MVP, not deferred:** audit log is the one feature whose history is *lost forever* if you defer it. Multi-user without audit trail means "someone changed an invoice and you can't tell" — unacceptable for accounting software.

### Position
- **Dashboard** — one screen: money in, money out, what's owed, what you owe

### AI Layer (Pro / BYOK)
- **Cash flow nudges** — "January is historically slow; you have $800"
- **Late payer detection** — "this client pays late 80% of the time"
- **Anomaly flagging** — "expenses 40% higher than 3-month average"
- **Expense categorization** — AI suggests, user confirms

### Infrastructure (built first, before features)
- **Telemetry module** — opt-in, anonymous, fully documented (see TELEMETRY.md). Trust signal, built before MVP features.

---

## Roadmap Beyond MVP

### v1.1 (post-MVP near-term)
- **Per-company permissions** — a user has access to some companies but not others. *(The 5-role workspace capability model, member removal, and ownership transfer already shipped; per-company scoping is the remaining piece.)*
- **Customer opt-in saved card** — Stripe Customer + Payment Method. "Save card for next invoice" checkbox on the public invoice view. Subsequent invoices pre-fill the saved card; customer taps once. Not auto-charge — customer still acts.
- **AI tax readiness** — structured quarterly tracker with set-aside calculations, dates, IRS Schedule C alignment. Beyond a simple insight; a real product surface.
- **Natural language queries** — "how much did I make last month?" Open-ended chat surface; deferred from MVP because it's the riskiest AI feature to ship well.
- **Bank feed (Plaid / Teller)** — highest-priority post-launch add. Auto-imports transactions, dedupes against manual entries.
- **Mileage tracking** — manual trip entry (date, miles, purpose, vehicle) producing the standard-mileage deduction. *(TMC-179. Promoted from v1.2+ on 2026-08-05 and rescoped: GPS / background-location auto-detection is explicitly **out**, and that was the entire reason this read as a "big native-mobile build." Without it the feature is small. The tax worksheet already flags Schedule C line 9 as user-supplied precisely because we don't track this — see `apps/api/src/lib/tax-worksheet.ts`.)*
- **Jobs** — a named work container that exists before any invoice, owning hours and costs and emitting zero or more invoices. *(TMC-181. Job costing shipped with the invoice standing in for the job, and accepted the limits: deposit-plus-final reads as two jobs, recurring work floods the list. Time tracking is what breaks the stand-in, because the work exists before the invoice does. Flat — still no project hierarchy.)*
- **Time tracking** — timer start/stop **plus a plain duration field**, logged against a job, converted to invoice line items. No project hierarchy, no team tracking. *(TMC-180. Promoted from v1.2+ on 2026-08-05; blocked on Jobs above.)*

### v1.2+ (deferred but planned)
- **Client portal (full)** — multi-invoice customer login, payment history, statements. Significant product surface.
- **Expense categories & rules** — user-defined rules for auto-categorization of recurring expenses.

### Possibly never / v2
- **Auto-charge subscription billing** — true subscription model (card-on-file auto-charged on the recurrence schedule). Brand decision as much as engineering: makes Thalermark feel less like accounting and more like a subscription service. Revisit only after explicit demand. *Nothing is built toward this: no Stripe Customer, no saved payment method, no `setup_future_usage` anywhere in the codebase. Stripe supports it; we have never wired it. The v1.1 opt-in saved card is the prerequisite step, and is deliberately **not** auto-charge.*

### Long-term full feature set (per original brief)
- Approval workflows
- Custom report builder
- White labeling
- SSO / SAML
- Intercompany transactions
- Multi-currency with FX gain/loss

---

## AI Layer — MVP Scope

Not ChatGPT bolted on. Woven into the core interaction. Available to Pro+ tier on SaaS and to self-hosters with BYOK.

**MVP:**
- **Anomaly flagging** — "your expenses are 40% higher than your 3 month average"
- **Cash flow nudges** — "based on your history, January is slow — you have $800 in the bank"
- **Invoice intelligence** — "this client pays late 80% of the time"
- **Expense categorization suggestions** — AI suggests, user confirms
- **Receipt extraction** — vision LLM reads receipt images and structures the data (see Expenses MVP)

**v1.1:**
- **Tax readiness** — structured quarterly tracker (moved to v1.1 as a real product surface, not just a one-line insight)
- **Natural language queries** — "how much did I make last month?" (open-ended chat surface; deferred to v1.1 because it's the riskiest AI feature to ship well, and the proactive insights above deliver "AI value" without it)

The AI layer is the primary premium differentiator. Basic invoicing and expense tracking is free. Intelligence is Pro.

---

## Compliance

- **US-first by default** — 1099 awareness, self-employment tax estimates, quarterly reminders
- **Pluggable architecture** — compliance is a module, swappable for UK VAT, Canadian GST, etc.
- **Not financial advice** — AI frames everything as awareness, not advice

---

## Monetization

No hard paywall at launch. Value ladder approach:

| Tier | What they get |
|---|---|
| Community | Free, self-hosted, core features, GitHub support |
| Cloud | Managed hosting, automatic updates, backups |
| Pro | Cloud + AI insights, priority support |
| Accountant | Pro + multi-client workspaces, white label, dedicated support |

Specific tier pricing is held off-repo until pre-launch.

**Early revenue sequence:**
1. Paid setup calls — one-time fee, immediate
2. Managed cloud hosting — first recurring revenue
3. AI insights as Pro tier — once good enough to charge for

**Key metric:** an attainable paying-user count at the Pro tier within 12 months of launch, using existing open-source-accounting community networks as launchpad. Specific targets held off-repo.

---

## Go To Market

**Launch network:** existing open-source-accounting communities — users already frustrated with current tools and looking for something better. Personal contacts within those communities are the first testers.

**Build in public:** GitHub, changelog, community Discord or similar. Transparency is a feature for this audience.

**Email capture from day one:** Everyone who installs, visits, or stars the repo. The list is the most valuable asset at launch.

Full GTM plan not yet built out. Priority after name and tech stack are locked.

---

## Email Capture Strategy

- Landing page before product is built — validate demand
- README links to stay updated page
- First-run setup offers optional email for updates
- Every cloud signup captured automatically
- Tool: Resend or Mailchimp, simple form, name and email only

---

## Telemetry

Opt-in only. Anonymous. Fully documented.

See `TELEMETRY.md` for complete specification including every event collected, opt-out instructions, and data retention policy.

Key principle: the telemetry code is open source and auditable. Aggregate findings published publicly on a regular cadence.

---

## Mobile Strategy

**Directional: React Native + Expo.** Not locked in but leaning strongly native. Primary audience is never at a desk — receipt capture, push notifications for invoice payment, and lock screen presence are all better native. Expo EAS handles build complexity. Web version still needed for accountant tier. Confirm before scaffolding begins.

---

## Tech Stack

**Not yet decided.** Next major conversation.

Constraints to consider:
- Must support AI integration cleanly
- Self-hosting must be simple — single docker compose up ideally
- Contributor-friendly — common languages lower barrier to contribution
- Mobile-first frontend
- PostgreSQL strongly preferred for multi-tenancy

---

## Open Questions (Blocking)

These must be answered before build begins:

1. ~~**Name**~~ — ✅ **Thalermark** (locked, `thalermark.com` registered)
2. ~~**Tech stack**~~ — ✅ Fully locked. See TECH-STACK.md.
3. ~~**Mobile strategy**~~ — ✅ React Native + Expo
4. ~~**Licensing specifics**~~ — ✅ AGPL v3 + Commercial Dual
5. **MVP feature scope** — formal written list, no additions without explicit decision

---

## Open Questions (Non-blocking)

These can be figured out in motion:

- Payment processor specifics — Stripe Connect mechanics
- Self-hosted license enforcement — license keys, feature flags, honor system
- Brand identity — visual language, tone of voice, logo
- Contributor guidelines and community structure
- Full GTM plan

---

## What's Done

- Business requirements — complete
- Audience definition — complete
- Monetization model — complete
- Telemetry specification — complete (`TELEMETRY.md`)
- Feature set — complete (MVP scoped, full set documented)
- Compliance approach — complete
- Email capture strategy — complete

---

## Immediate Next Steps

1. ~~Lock the name~~ ✅ Thalermark, `thalermark.com` registered
2. Register defensive domains (.io, .app, .dev, .co, .net)
3. Decide tech stack
4. Confirm mobile strategy (React Native + Expo)
5. Formally define MVP feature list
6. Build landing page on thalermark.com and start email capture
7. Set up GitHub repo with README, LICENSE, TELEMETRY.md, CONTRIBUTING.md
8. File USPTO trademark application (Classes 9, 36, 42) once product is in commercial use
