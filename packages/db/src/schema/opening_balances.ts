import { sql } from 'drizzle-orm';
import {
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { chartOfAccounts } from './chart_of_accounts.js';
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
    // 'simple' — the three plain questions, and the three columns below hold the
    //            answers verbatim.
    // 'full'    — an opening trial balance entered account by account (what Xero
    //            calls conversion balances). The three columns are 0 and mean
    //            nothing; read openingBalanceLines instead.
    // Display only. LINES ARE ALWAYS AUTHORITATIVE FOR POSTING, whichever shape
    // produced them, so there is exactly one path into the ledger.
    shape: text('shape').notNull().default('simple'),
    // The simple shape's three figures, kept as a denormalization so the plain
    // "what was in the bank when you started" screen reads them without walking
    // lines. Zero under the 'full' shape.
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

// One account's starting balance. Same {account, side, amount} shape as
// journal_lines and as a manual journal entry's lines — direction lives in
// `side`, never in the sign, so there is only ever one way to say a thing.
//
// This is what actually gets posted. The simple shape's three figures are
// expanded into four of these (Dr Cash / Dr A/R / Cr A/P, Owner's Equity as the
// sign-aware plug) at write time, so the ledger has a single entry path
// regardless of which screen the user filled in.
//
// coa_account_id is RESTRICT on delete, matching journal_lines: a starting
// balance is evidence, and an account it references must not vanish underneath
// it. Rows are replaced wholesale on edit (delete-then-insert) rather than
// patched — the parent's edit is already a reverse-and-repost, so per-line
// identity would buy nothing.
export const openingBalanceLines = pgTable(
  'opening_balance_lines',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    openingBalanceId: uuid('opening_balance_id')
      .notNull()
      .references(() => openingBalances.id, { onDelete: 'cascade' }),
    coaAccountId: uuid('coa_account_id')
      .notNull()
      .references(() => chartOfAccounts.id, { onDelete: 'restrict' }),
    side: text('side').notNull(),
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('opening_balance_lines_account_id_idx').on(table.accountId),
    parentIdx: index('opening_balance_lines_parent_idx').on(table.openingBalanceId),
  }),
);

export type OpeningBalanceLine = typeof openingBalanceLines.$inferSelect;
export type NewOpeningBalanceLine = typeof openingBalanceLines.$inferInsert;
