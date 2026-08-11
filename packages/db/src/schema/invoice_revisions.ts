import { date, index, numeric, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { companies } from './companies.js';
import { invoices } from './invoices.js';

// One row per time a SENT invoice was pulled back to be corrected (TMC-227).
//
// The correction flow is deliberately same-row: an invoice keeps its number, its
// public token and its payments across a revision, so the customer's link never
// dies and the numbering never gains an INV-0007-2. What that costs is history —
// once the draft is edited, nothing in the invoice row remembers what the
// customer was originally told. These rows are that memory.
//
// They are also the visible half of the feature. QuickBooks edits silently and
// keeps its audit log private; Thalermark shows the recipient "Revised Aug 11,
// 2026 — the total was $450.00" on the same page they were going to pay from.
// That honesty is the differentiator, and it needs a durable snapshot rather
// than a reconstruction from audit diffs.
//
// WRITE-ONCE. A row is inserted in the same transaction as the sent → draft
// transition and never updated, hence no updated_at. The invoice may be revised
// any number of times; the rows accumulate, newest first when read.
//
// The snapshot is deliberately narrow — total, issue date, due date — not a
// whole invoice copy. Those three are what a recipient can act on and what the
// ledger reversal moved. The full before/after diff already exists in
// audit_events for the operator; this table exists for the CUSTOMER's page.
export const invoiceRevisions = pgTable(
  'invoice_revisions',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    // CASCADE, matching invoice_payments.invoice_id: a revision of nothing is
    // not a record worth keeping. There is no invoice DELETE endpoint today, so
    // this is a data-integrity backstop rather than a live path.
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    // When the pull-back happened. A timestamptz, unlike the two date columns
    // below: this is an event in real time, not a document date, and it is what
    // both the customer's "Revised Aug 11" line and the operator's nudge read.
    revisedAt: timestamp('revised_at', { withTimezone: true }).notNull(),
    // What the customer was last told. Captured BEFORE the edit — the row still
    // holds the values being reversed at snapshot time, which is the same
    // discipline that keeps the ledger reversal honest.
    previousTotal: numeric('previous_total', { precision: 15, scale: 2 }).notNull(),
    // Bare calendar dates, mirroring invoices.issue_date / due_date. The issue
    // date matters because the revenue reversal posted against it: if the
    // corrected invoice is re-issued under a different date, this is the record
    // of which period the original lived in.
    previousIssueDate: date('previous_issue_date', { mode: 'string' }).notNull(),
    previousDueDate: date('previous_due_date', { mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('invoice_revisions_account_id_idx').on(table.accountId),
    // Backs the only read there is: every revision of one invoice, newest first,
    // for the detail page, the public page and the amended email.
    invoiceIdIdx: index('invoice_revisions_invoice_id_idx').on(
      table.accountId,
      table.invoiceId,
      table.revisedAt,
    ),
  }),
);

export type InvoiceRevision = typeof invoiceRevisions.$inferSelect;
export type NewInvoiceRevision = typeof invoiceRevisions.$inferInsert;
