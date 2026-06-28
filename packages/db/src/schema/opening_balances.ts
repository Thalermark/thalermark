import { sql } from 'drizzle-orm';
import { date, index, numeric, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { companies } from './companies.js';

// Opening balances — what the business already had when it started using
// Thalermark, so the books are right from day one instead of starting at zero.
// Surfaced in "My Money" in plain language ("money in the bank when you
// started", "money customers already owed you", "money you already owed"); the
// double-entry stays hidden ([[project_ledger_decision]]).
//
// Header-only and singular: a company has exactly ONE starting position (the
// partial unique index enforces one active row per company). The three figures
// post a single combined, balanced journal entry against the standard accounts,
// with Owner's Equity (3000) as the balancing plug:
//   Dr Cash 1000            = cash
//   Dr Accounts Receivable  = receivables   (what customers owed)
//   Cr Accounts Payable     = payables      (what you owed)
//   Owner's Equity 3000     = cash + receivables − payables (Cr if +, Dr if −)
// (Reusing Owner's Equity rather than a dedicated Opening Balance Equity account
// keeps it consistent with the My Money model — a contribution also credits
// 3000 — and avoids an accountant-facing "clear OBE" step; an accountant can
// still reclassify in The Ledger. Opening AR/AP reflect the starting position;
// there are no invoices/bills behind them, so they're adjusted by editing this
// row, not through the invoice/bill-paid flows.)
//
// Edit = reverse the prior entry + repost (like owner money events / expenses);
// clear = soft delete (deleted_at) + a reversal. amounts are numeric(15,2)
// returned as decimal strings ([[architecture_money_decimal_strings]]);
// as_of_date is the bare calendar date the entry posts at (the start date).
export const openingBalances = pgTable(
  'opening_balances',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    asOfDate: date('as_of_date', { mode: 'string' }).notNull(),
    cash: numeric('cash', { precision: 15, scale: 2 }).notNull().default('0'),
    receivables: numeric('receivables', { precision: 15, scale: 2 }).notNull().default('0'),
    payables: numeric('payables', { precision: 15, scale: 2 }).notNull().default('0'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('opening_balances_account_id_idx').on(table.accountId),
    // One ACTIVE opening balance per company (a starting position is singular);
    // a soft-deleted one doesn't block setting a fresh one.
    companyActiveUq: uniqueIndex('opening_balances_company_active_uq')
      .on(table.companyId)
      .where(sql`${table.deletedAt} is null`),
  }),
);

export type OpeningBalance = typeof openingBalances.$inferSelect;
export type NewOpeningBalance = typeof openingBalances.$inferInsert;
