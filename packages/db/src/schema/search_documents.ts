import { sql } from 'drizzle-orm';
import {
  bigint,
  customType,
  date,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { companies } from './companies.js';

// tsvector has no first-class drizzle type. This is the first customType in the
// repo; it exists only so the generated column can be named in queries.
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
});

// One row per searchable entity (TMC-198): a denormalized projection of
// invoices, estimates, contacts, expenses, bills, jobs and items into a single
// table, so global search is one indexed scan rather than an ILIKE fan-out
// across six tables.
//
// WHY A PROJECTION TABLE AT ALL. No text-matching operator in PG 17 is
// leakproof, and Postgres will not evaluate a non-leakproof qual before an RLS
// policy qual. On the business tables that means `ILIKE`/`@@` can never become
// an index condition — a GIN index there would simply go unused. Measured, with
// the plans, in spikes/SEARCH-RLS-INDEX.md. Reads therefore go through
// search_documents_match(), a SECURITY DEFINER function whose owner is exempt
// from the policy; the caller then re-reads these rows by primary key THROUGH
// RLS, so the policy below remains the actual fence.
//
// THE PRIMARY KEY IS (entity_type, entity_id), not the repo-standard
// `id uuid PRIMARY KEY`. A document has no identity of its own — it is a
// projection of the row it names — so the row's identity is its identity. That
// also makes it the natural ON CONFLICT target for the projector, with no
// uuidv7 to mint and no second lookup to find the existing document.
//
// EVERY INDEX LEADS WITH account_id. A plain gin(tsv) on a multi-tenant table
// is tenant-blind: its scan cost tracks how many rows match the term across
// every tenant, then account_id filters the heap fetches. btree_gin lets the
// tenant lead, which is both faster and smaller (11MB vs 15MB at 330k rows).
export const searchDocuments = pgTable(
  'search_documents',
  {
    // Plain text rather than a pg enum: adding an eighth searchable entity
    // should be a projector, not a migration. SEARCH_ENTITY_TYPES in
    // @thalermark/validation is the authority on the permitted values.
    entityType: text('entity_type').notNull(),
    // Deliberately NOT a foreign key — the table is polymorphic across every
    // domain entity, exactly like audit_events.entity_id. Referential integrity
    // is maintained instead by the projector (an id it no longer returns is
    // deleted) and repaired by the weekly reindex sweep.
    entityId: uuid('entity_id').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    // Display text, original case and accents. What the dropdown renders.
    title: text('title').notNull(),
    subtitle: text('subtitle'),

    // Indexing text: lowercased, accent-folded, whitespace-collapsed by
    // normalizeText() at projection time. Normalizing in TypeScript rather than
    // with unaccent() is forced, not stylistic — unaccent() is STABLE, so it is
    // illegal in a generated column without the immutable_unaccent wrapper, and
    // that wrapper lies to the planner and corrupts on dictionary change.
    // The query path MUST normalize with the same function.
    titleNorm: text('title_norm').notNull(),
    // Numbers and references (invoice number, bill reference) carried at weight
    // A alongside the title, so searching "1042" ranks the invoice at the top.
    refNorm: text('ref_norm'),
    subtitleNorm: text('subtitle_norm'),
    // Free text: notes, memos, concatenated line-item descriptions. Capped at
    // 2000 chars by truncateBody(). That cap is correctness, not tuning — GIN
    // rejects a tsvector over 1MB outright, so an uncapped 200-line invoice
    // would throw on insert.
    bodyNorm: text('body_norm'),

    status: text('status'),
    // Cents, and bigint rather than numeric, because int8eq is one of the three
    // leakproof operators — so exact-amount matching stays indexable even in
    // plans where the text predicates cannot be.
    amountCents: bigint('amount_cents', { mode: 'number' }),
    occurredOn: date('occurred_on', { mode: 'string' }),

    // The source row's updated_at. The recency tiebreak in every ORDER BY, so
    // equally-ranked hits surface most-recently-touched first.
    entityUpdatedAt: timestamp('entity_updated_at', { withTimezone: true }).notNull(),
    // When this projection was last written. The sweep reaps anything older
    // than its own run start, which is how a delete the request path missed
    // self-heals — and why concurrent writes survive a sweep.
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),

    // Generated by Postgres on write, so it can never drift from the columns it
    // summarizes. 'simple' rather than 'english': stemming and stopword removal
    // are wrong over invoice numbers, names and reference codes. Prefix
    // matching (:*) covers what stemming would have bought.
    tsv: tsvector('tsv').generatedAlwaysAs(
      sql`setweight(to_tsvector('simple'::regconfig, coalesce("title_norm", '')), 'A') || setweight(to_tsvector('simple'::regconfig, coalesce("ref_norm", '')), 'A') || setweight(to_tsvector('simple'::regconfig, coalesce("subtitle_norm", '')), 'B') || setweight(to_tsvector('simple'::regconfig, coalesce("body_norm", '')), 'C')`,
    ),
  },
  (t) => [
    primaryKey({ columns: [t.entityType, t.entityId], name: 'search_documents_pkey' }),
    // The main event: tenant + term in one index scan, inside the SECURITY
    // DEFINER function.
    index('search_documents_account_tsv_idx').using('gin', t.accountId, t.tsv),
    // Typo tolerance ("Jonson" -> "Johnson"). Title only, never body: a trigram
    // index over free-text bodies gets enormous, and the misspellings that
    // actually happen are in names, numbers and merchants.
    index('search_documents_account_title_trgm_idx').using(
      'gin',
      t.accountId,
      t.titleNorm.op('gin_trgm_ops'),
    ),
    // Backs the recency tiebreak and the sweep's per-account keyset paging.
    index('search_documents_account_updated_idx').on(
      t.accountId,
      t.entityUpdatedAt.desc(),
      t.entityId.desc(),
    ),
    // Exact-amount matching. Partial because only five of the seven entity
    // types carry money at all.
    index('search_documents_account_amount_idx')
      .on(t.accountId, t.amountCents)
      .where(sql`${t.amountCents} IS NOT NULL`),
    index('search_documents_account_company_idx').on(t.accountId, t.companyId),
  ],
);
