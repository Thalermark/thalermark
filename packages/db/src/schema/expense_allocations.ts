import { sql } from 'drizzle-orm';
import { index, numeric, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { companies } from './companies.js';
import { expenses } from './expenses.js';
import { invoices } from './invoices.js';

// Job costing (TMC-174) — which job a cost was for, so the user can be told
// whether that job made money. One question on a receipt, one number per job.
//
// A join table rather than a column on expenses, because one purchase routinely
// covers several jobs: a landscaper buys 100lb of seed for three houses, prices
// each flat, and never line-items the seed to anyone. No single foreign key can
// express that, which is what ruled out the obvious cheap designs (an
// expenses.invoice_id, or reusing expenses.customer_contact_id — the latter
// exists but is contact-grain and 1:1, so it stays where it is and is not this).
//
// The invoice IS the job. There is deliberately no jobs/projects entity: the
// user already thinks in "the Smith job", and an invoice labelled with the
// customer's name reads exactly that way at a fraction of the cost. Known
// limits, accepted: a deposit-plus-final pair shows as two jobs, and recurring
// work makes a long list. A real jobs entity is the fix if those ever bite.
//
// invoice_id NULL is the SHARED pool — the deliberate answer for a cost the user
// won't attribute (the seed), as opposed to no rows at all, which means he never
// answered. Keeping those distinct is the point: shared is a real answer and the
// UI must never nag him to split it. Nothing is ever auto-apportioned; inventing
// a 1/3 split he did not give is a lie that looks like a fact.
//
// share is a FRACTION of the expense, not a money amount, so it survives an edit
// to the expense total without going stale. Nothing here is ever summed into a
// stored figure — margin is computed fresh at read time, the same read-time-lens
// pattern as the cash/accrual basis toggle on the tax worksheets.
//
// This table posts NOTHING to the ledger and is not referenced by it. Both
// halves already post correctly on their own (revenue to 4000/4100 by line type,
// cost to its expense category); this is a tag, not a route. Drop the whole table
// and the user loses the job screen while his books, taxes and invoices are
// untouched — that property is deliberate, and a design that starts wanting
// journal entries to make margin work is the wrong design.
export const expenseAllocations = pgTable(
  'expense_allocations',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    expenseId: uuid('expense_id')
      .notNull()
      .references(() => expenses.id, { onDelete: 'cascade' }),
    // NULL = shared. Cascade rather than restrict: deleting an invoice should
    // not be blocked by a costing tag, and losing the tag costs nothing but the
    // attribution (the expense itself is untouched).
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'cascade' }),
    // (0, 1]. Rows for one expense sum to 1 — enforced on write in the API,
    // which replaces the whole set atomically, not by a trigger here.
    share: numeric('share', { precision: 9, scale: 6 }).notNull().default('1'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('expense_allocations_account_id_idx').on(table.accountId),
    expenseIdIdx: index('expense_allocations_expense_id_idx').on(table.expenseId),
    // Backs the per-invoice cost rollup on the invoice detail view and the
    // job-margin report, both scoped by account + company first.
    invoiceIdIdx: index('expense_allocations_invoice_id_idx').on(
      table.accountId,
      table.companyId,
      table.invoiceId,
    ),
    // One row per (expense, invoice). Split as two partial indexes because
    // Postgres treats NULLs as distinct in a plain unique index, which would
    // otherwise let an expense collect several "shared" rows.
    expenseInvoiceUq: uniqueIndex('expense_allocations_expense_invoice_uq')
      .on(table.expenseId, table.invoiceId)
      .where(sql`${table.invoiceId} is not null`),
    expenseSharedUq: uniqueIndex('expense_allocations_expense_shared_uq')
      .on(table.expenseId)
      .where(sql`${table.invoiceId} is null`),
  }),
);

export type ExpenseAllocation = typeof expenseAllocations.$inferSelect;
export type NewExpenseAllocation = typeof expenseAllocations.$inferInsert;
