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
import { recurringInvoices } from './recurring-invoices.js';

// Invoice header. Money columns are numeric(15,2) — exact-precision arithmetic
// in Postgres, returned as string in TS to dodge JS float precision. Status is
// a plain text column ('draft' default; 'sent' / 'paid' / 'voided' set by the
// transition endpoints). issue_date and due_date are bare dates (no
// time-of-day, no TZ) to keep "due on the 15th" out of the timezone rabbit
// hole. number is unique within (account_id, company_id) — invoice numbers
// belong to the company, not the workspace.
//
// customer_id is RESTRICT on delete: customers with invoices cannot be
// hard-deleted. The MVP path is to keep customers around for invoice history;
// soft-delete / archival is a v1.x decision.
//
// sent_at / paid_at / voided_at record when each transition fired (timestamptz,
// nullable, set once by the state machine). public_token is set on the
// draft → sent transition (32 random bytes hex, same pattern as the invite
// token) and gates the unauthed /api/public/invoices/:token route — drafts
// don't have one, so they're never publicly addressable.
export const invoices = pgTable(
  'invoices',
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
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    currency: text('currency').notNull().default('USD'),
    subtotal: numeric('subtotal', { precision: 15, scale: 2 }).notNull().default('0'),
    tax: numeric('tax', { precision: 15, scale: 2 }).notNull().default('0'),
    total: numeric('total', { precision: 15, scale: 2 }).notNull().default('0'),
    notes: text('notes'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    publicToken: text('public_token'),
    // How a paid invoice was settled, recorded on the mark-paid transition.
    // payment_method is the channel: 'cash' | 'check' | 'venmo' | 'zelle' |
    // 'other' from the manual picker, or 'stripe' stamped automatically by the
    // payment_intent.succeeded webhook. payment_reference is an optional note —
    // a check number, a confirmation code. Both null until paid. Display-only:
    // no ledger effect (the mark-paid posting is always Dr Cash / Cr AR).
    // App-layer enum; CHECK deferred like business_type.
    paymentMethod: text('payment_method'),
    paymentReference: text('payment_reference'),
    // Provenance link for invoices minted by a recurring schedule's sweeper.
    // Null for hand-created invoices. ON DELETE SET NULL so ending+deleting a
    // schedule never cascades through generated-invoice history (mirrors
    // estimates.converted_invoice_id).
    recurringInvoiceId: uuid('recurring_invoice_id').references(() => recurringInvoices.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('invoices_account_id_idx').on(table.accountId),
    companyIdIdx: index('invoices_company_id_idx').on(table.companyId),
    customerIdIdx: index('invoices_customer_id_idx').on(table.customerId),
    statusIdx: index('invoices_status_idx').on(table.status),
    companyNumberUq: uniqueIndex('invoices_company_number_uq').on(table.companyId, table.number),
    publicTokenUq: uniqueIndex('invoices_public_token_uq').on(table.publicToken),
    recurringInvoiceIdIdx: index('invoices_recurring_invoice_id_idx').on(table.recurringInvoiceId),
  }),
);

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;

// Line items belong to a single invoice and inherit the invoice's tenant.
// account_id is denormalized onto the row so the standard NULLIF RLS idiom
// works without joining back to invoices — matches the codebase pattern
// (audit_events, telemetry_events both do this). position is a 1-based ordinal
// for stable rendering; the app assigns it. amount = quantity * unit_price is
// computed at the application layer and stored as a column for query speed
// and to make historical totals reproducible if rates ever change.
export const invoiceLineItems = pgTable(
  'invoice_line_items',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    position: bigint('position', { mode: 'number' }).notNull(),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 15, scale: 4 }).notNull(),
    unitPrice: numeric('unit_price', { precision: 15, scale: 2 }).notNull(),
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('invoice_line_items_account_id_idx').on(table.accountId),
    invoiceIdIdx: index('invoice_line_items_invoice_id_idx').on(table.invoiceId),
  }),
);

export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect;
export type NewInvoiceLineItem = typeof invoiceLineItems.$inferInsert;
