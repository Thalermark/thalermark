import { index, numeric, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { companies } from './companies.js';
import { estimates } from './estimates.js';

// The estimate half of TMC-227 — one row per time a SENT estimate was pulled
// back to be corrected. Same shape and same purpose as invoice_revisions, and a
// separate concrete table rather than a polymorphic document_revisions for the
// reason the rest of the schema is concrete: a real foreign key to the document
// it belongs to is worth more than a saved CREATE TABLE.
//
// Narrower than its invoice twin by one thing that is not an oversight:
// estimates post NOTHING to the ledger, so there is no issue date whose period
// the reversal landed in. previous_total is the whole story — it is the number
// the customer was quoted, and the only thing the revision note has to say.
export const estimateRevisions = pgTable(
  'estimate_revisions',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    estimateId: uuid('estimate_id')
      .notNull()
      .references(() => estimates.id, { onDelete: 'cascade' }),
    revisedAt: timestamp('revised_at', { withTimezone: true }).notNull(),
    previousTotal: numeric('previous_total', { precision: 15, scale: 2 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('estimate_revisions_account_id_idx').on(table.accountId),
    estimateIdIdx: index('estimate_revisions_estimate_id_idx').on(
      table.accountId,
      table.estimateId,
      table.revisedAt,
    ),
  }),
);

export type EstimateRevision = typeof estimateRevisions.$inferSelect;
export type NewEstimateRevision = typeof estimateRevisions.$inferInsert;
