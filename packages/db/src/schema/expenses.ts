import { date, index, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { chartOfAccounts } from './chart_of_accounts.js';
import { companies } from './companies.js';
import { contacts } from './contacts.js';

// Expenses are the third MVP entity chain (after contacts + invoices/estimates),
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
// invoice/estimate convention). customer_contact_id is the job-costing link —
// which contact (acting as customer) the expense was incurred for. Carried
// nullable from day one even though MVP doesn't expose it — avoids a backfill
// when job-costing surfaces in v1.x. ON DELETE RESTRICT mirrors invoices:
// contacts with expenses can't be hard-deleted. The buy-from side
// (vendor_contact_id) lands with the expense vendor-link slice.
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
// merchant stays free text: receipt OCR writes the raw string off the receipt
// with no vendor link required. The optional structured vendor link
// (vendor_contact_id → contacts where is_vendor) is added with the expense
// vendor-link slice; bills / accounts payable remain deferred. memo is the
// user's note.
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
    customerContactId: uuid('customer_contact_id').references(() => contacts.id, {
      onDelete: 'restrict',
    }),
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
    customerContactIdIdx: index('expenses_customer_contact_id_idx').on(table.customerContactId),
    categoryAccountIdIdx: index('expenses_category_account_id_idx').on(table.categoryAccountId),
    paymentAccountIdIdx: index('expenses_payment_account_id_idx').on(table.paymentAccountId),
    expenseDateIdx: index('expenses_expense_date_idx').on(table.expenseDate),
    // Backs the keyset list query: WHERE account_id ORDER BY expense_date DESC,
    // created_at DESC, id DESC.
    accountDateIdx: index('expenses_account_date_idx').on(
      table.accountId,
      table.expenseDate.desc(),
      table.createdAt.desc(),
      table.id.desc(),
    ),
  }),
);

export type Expense = typeof expenses.$inferSelect;
export type NewExpense = typeof expenses.$inferInsert;
