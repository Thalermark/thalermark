import { sql } from 'drizzle-orm';
import { date, index, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { chartOfAccounts } from './chart_of_accounts.js';
import { companies } from './companies.js';
import { contacts } from './contacts.js';

// Vendor bills — accounts payable. A bill is "an expense you owe but haven't
// paid yet": it recognises the cost now (Dr <category> / Cr Accounts Payable)
// and settles it later (Dr Accounts Payable / Cr <payment asset>). This is the
// mirror image of the AR machine (invoices) and the accrual sibling of the
// cash-basis `expenses` entity — same Dr <category> leg, but credited to AP
// (2000) instead of Cash so the position dashboard's "owing" figure is real.
//
// Per [[project_ledger_decision]] the double-entry stays hidden: users see
// "Bills" / "what you owe", never "Accounts Payable". A bill is real the moment
// it's recorded, so there is no draft state — status is 'open' on create
// (posts Dr category / Cr AP), 'paid' on settle (posts Dr AP / Cr payment), or
// 'voided' (reverses the open posting). Edit is allowed only while 'open'
// (reverse + repost, like expenses); paid/voided bills are immutable, mirroring
// the invoice rule.
//
// contact_id is the vendor (NOT NULL — a bill is always owed to someone; the
// vendor is a contact with is_vendor set). category_account_id is the expense
// COA row the cost lands in; payment_account_id is the asset it's paid from,
// null until the mark-paid transition stamps it. Money is numeric(15,2) returned
// as a decimal string ([[architecture_money_decimal_strings]]); amount is the
// full total owed (sales tax on a purchase is part of the cost for the
// cash-basis sole-prop audience — there is no reclaimable input tax in the US —
// so it rolls into the single amount, matching the expense entity which has no
// separate tax column). bill_date / due_date are bare dates (no TZ), matching
// the invoice/estimate/expense convention; due_date drives the AP aging report.
//
// Header-only for MVP, like its `expenses` sibling: one bill, one category.
// Multi-category itemised supplier invoices are a follow-on (bill_line_items),
// deferred until a real consumer needs them.
export const bills = pgTable(
  'bills',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'restrict' }),
    categoryAccountId: uuid('category_account_id')
      .notNull()
      .references(() => chartOfAccounts.id, { onDelete: 'restrict' }),
    paymentAccountId: uuid('payment_account_id').references(() => chartOfAccounts.id, {
      onDelete: 'restrict',
    }),
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
    billDate: date('bill_date', { mode: 'string' }).notNull(),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    currency: text('currency').notNull().default('USD'),
    // The vendor's own bill / invoice number. Free text, optional, NOT unique —
    // it belongs to the vendor, so two different vendors can both number a bill
    // "INV-001". Display + record only; we never number bills ourselves.
    reference: text('reference'),
    memo: text('memo'),
    status: text('status').notNull().default('open'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    // How a paid bill was settled, stamped on the mark-paid transition (mirrors
    // invoices.payment_method/reference). Display-only — the posting is always
    // Dr AP / Cr <payment asset>. App-layer enum; CHECK deferred like elsewhere.
    paymentMethod: text('payment_method'),
    paymentReference: text('payment_reference'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('bills_account_id_idx').on(table.accountId),
    companyIdIdx: index('bills_company_id_idx').on(table.companyId),
    contactIdIdx: index('bills_contact_id_idx').on(table.contactId),
    categoryAccountIdIdx: index('bills_category_account_id_idx').on(table.categoryAccountId),
    paymentAccountIdIdx: index('bills_payment_account_id_idx').on(table.paymentAccountId),
    statusIdx: index('bills_status_idx').on(table.status),
    // Backs the keyset list query: WHERE account_id ORDER BY created_at DESC, id DESC.
    accountCreatedAtIdx: index('bills_account_created_at_idx').on(
      table.accountId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    // Backs the AP aging report: open bills for a company ordered by due date.
    openDueIdx: index('bills_open_due_idx')
      .on(table.accountId, table.companyId, table.dueDate)
      .where(sql`${table.status} = 'open'`),
  }),
);

export type Bill = typeof bills.$inferSelect;
export type NewBill = typeof bills.$inferInsert;
