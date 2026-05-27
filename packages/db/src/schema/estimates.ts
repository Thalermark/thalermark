import {
  bigint,
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
import { companies } from './companies.js';
import { customers } from './customers.js';
import { invoices } from './invoices.js';

// Estimates mirror the invoice header. Status is 'draft' default with the rest
// set by the transition endpoints ('sent' / 'accepted' / 'declined' /
// 'expired'). expires_on is a bare date — read sites compute "isExpired = sent
// && expires_on < today" advisory; we don't background-sweep status until
// pg-boss is wired (see SCAFFOLDING §8.7 plan).
//
// converted_invoice_id is the link to the invoice created via the "convert"
// action; ON DELETE SET NULL so deleting an invoice doesn't cascade through
// the estimate's history. customer_id is RESTRICT to match invoices.
//
// public_token gates the unauthed /api/public/estimates/:token route; minted
// on the draft → sent transition (same 32-byte hex pattern as invoices).
export const estimates = pgTable(
  'estimates',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    number: text('number').notNull(),
    status: text('status').notNull().default('draft'),
    issueDate: date('issue_date', { mode: 'string' }).notNull(),
    expiresOn: date('expires_on', { mode: 'string' }),
    currency: text('currency').notNull().default('USD'),
    subtotal: numeric('subtotal', { precision: 15, scale: 2 }).notNull().default('0'),
    tax: numeric('tax', { precision: 15, scale: 2 }).notNull().default('0'),
    total: numeric('total', { precision: 15, scale: 2 }).notNull().default('0'),
    notes: text('notes'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    declinedAt: timestamp('declined_at', { withTimezone: true }),
    expiredAt: timestamp('expired_at', { withTimezone: true }),
    convertedInvoiceId: uuid('converted_invoice_id').references(() => invoices.id, {
      onDelete: 'set null',
    }),
    publicToken: text('public_token'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('estimates_account_id_idx').on(table.accountId),
    companyIdIdx: index('estimates_company_id_idx').on(table.companyId),
    customerIdIdx: index('estimates_customer_id_idx').on(table.customerId),
    statusIdx: index('estimates_status_idx').on(table.status),
    companyNumberUq: uniqueIndex('estimates_company_number_uq').on(table.companyId, table.number),
    publicTokenUq: uniqueIndex('estimates_public_token_uq').on(table.publicToken),
  }),
);

export type Estimate = typeof estimates.$inferSelect;
export type NewEstimate = typeof estimates.$inferInsert;

// Estimate line items mirror invoice_line_items exactly (account_id
// denormalized for the standard NULLIF RLS idiom, position 1-based, amount
// pre-computed and stored).
export const estimateLineItems = pgTable(
  'estimate_line_items',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    estimateId: uuid('estimate_id')
      .notNull()
      .references(() => estimates.id, { onDelete: 'cascade' }),
    position: bigint('position', { mode: 'number' }).notNull(),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 15, scale: 4 }).notNull(),
    unitPrice: numeric('unit_price', { precision: 15, scale: 2 }).notNull(),
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('estimate_line_items_account_id_idx').on(table.accountId),
    estimateIdIdx: index('estimate_line_items_estimate_id_idx').on(table.estimateId),
  }),
);

export type EstimateLineItem = typeof estimateLineItems.$inferSelect;
export type NewEstimateLineItem = typeof estimateLineItems.$inferInsert;
