import { date, index, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { chartOfAccounts } from './chart_of_accounts.js';
import { companies } from './companies.js';
import { customers } from './customers.js';

// Expenses are the third MVP entity chain (after customers + invoices/estimates),
// built ledger-aware from day one — every create/edit/delete posts a balanced
// journal entry in the same tenant tx (see SCAFFOLDING.md §Phase 8 slice L
// rationale + the 8.9 chain plan).
//
// Posting at create is Dr <category> / Cr <payment>. Edit = full reversal of
// the prior entry + a new entry in one tx (no amend-in-place — keeps the GL
// clean). Delete is soft (deleted_at) and posts a reversal — the row stays
// for history because the audit trail and the reversal entry both reference
// it by id.
//
// Money column is numeric(15,2) returned as decimal string ([[architecture
// _money_decimal_strings]]); expense_date is bare date (no TZ, matches the
// invoice/estimate convention). customer_id is carried nullable from day one
// even though MVP doesn't expose it — avoids a backfill when job-costing
// surfaces in v1.x. ON DELETE RESTRICT mirrors invoices: customers with
// expenses can't be hard-deleted.
//
// category_account_id and payment_account_id both point at chart_of_accounts.
// API code validates that category is account_type='expense' and payment is
// account_type='asset' — the FK alone admits any COA row. Both are NOT NULL
// because the posting helper can't fall back on a default without making the
// GL ambiguous; the form picks Cash (1000) as the default payment account.
//
// receipt_storage_key + receipt_uploaded_at are the slice-8.9g hooks for
// receipt capture; extraction_status + extraction_payload are the slice-8.9h
// hooks for vision-LLM extraction. Both column groups land here so 8.9g/h
// don't need fresh migrations.
//
// merchant is free text in MVP — no vendor entity (bills / accounts payable
// is deferred v1.2+, per PROJECT.md). memo is the user's note.
export const expenses = pgTable(
  'expenses',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'restrict' }),
    categoryAccountId: uuid('category_account_id')
      .notNull()
      .references(() => chartOfAccounts.id, { onDelete: 'restrict' }),
    paymentAccountId: uuid('payment_account_id')
      .notNull()
      .references(() => chartOfAccounts.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
    expenseDate: date('expense_date', { mode: 'string' }).notNull(),
    merchant: text('merchant').notNull(),
    memo: text('memo'),
    receiptStorageKey: text('receipt_storage_key'),
    receiptUploadedAt: timestamp('receipt_uploaded_at', { withTimezone: true }),
    extractionStatus: text('extraction_status').notNull().default('none'),
    extractionPayload: jsonb('extraction_payload'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('expenses_account_id_idx').on(table.accountId),
    companyIdIdx: index('expenses_company_id_idx').on(table.companyId),
    customerIdIdx: index('expenses_customer_id_idx').on(table.customerId),
    categoryAccountIdIdx: index('expenses_category_account_id_idx').on(table.categoryAccountId),
    paymentAccountIdIdx: index('expenses_payment_account_id_idx').on(table.paymentAccountId),
    expenseDateIdx: index('expenses_expense_date_idx').on(table.expenseDate),
  }),
);

export type Expense = typeof expenses.$inferSelect;
export type NewExpense = typeof expenses.$inferInsert;
