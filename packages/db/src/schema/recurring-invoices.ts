import {
  bigint,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { companies } from './companies.js';
import { customers } from './customers.js';
import { items } from './items.js';

// A recurring invoice schedule: a template header + line items + a cadence
// that the background sweeper (pg-boss, first consumer) clones into a real
// invoice on each occurrence, marks sent, and emails. A schedule is a
// distinct entity from an invoice — it has no number, no issue/due date, no
// public token. Those are minted per generated invoice.
//
// Cadence: frequency in (weekly, monthly, yearly) × interval_count ("every N").
// interval_count is named with the _count suffix to dodge the SQL reserved
// word INTERVAL.
//
// next_run_date is the advisory date the sweeper reads — schedules with
// status='active' AND next_run_date <= today are due. After generating, the
// sweeper advances next_run_date forward by the cadence (clamping month/year
// math, e.g. Jan 31 +1mo → Feb 28) until it is strictly in the future, so a
// missed run after downtime collapses to a single invoice rather than a burst.
//
// End conditions are independent and either may be null: end_date (stop once
// next_run_date passes it) and max_occurrences (stop after that many generated
// invoices, tracked by occurrence_count). status moves active → paused (manual
// hold) and active|paused → ended (terminal — either an end condition was hit
// or the user ended it).
//
// net_terms_days drives the generated invoice's due date (issue + N days),
// defaulting to Net-30 like the duplicate-as-template flow. currency / subtotal
// / tax / total are the template snapshot copied onto each generated invoice
// header, mirroring the invoices table. customer_id is RESTRICT to match
// invoices (a customer with schedules can't be hard-deleted).
export const recurringInvoices = pgTable(
  'recurring_invoices',
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
    frequency: text('frequency').notNull(),
    // Counter / small-int columns are bigint, not integer — squawk's
    // prefer-bigint-over-int rule is active and these read fine as JS numbers.
    intervalCount: bigint('interval_count', { mode: 'number' }).notNull().default(1),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    nextRunDate: date('next_run_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }),
    maxOccurrences: bigint('max_occurrences', { mode: 'number' }),
    occurrenceCount: bigint('occurrence_count', { mode: 'number' }).notNull().default(0),
    status: text('status').notNull().default('active'),
    netTermsDays: bigint('net_terms_days', { mode: 'number' }).notNull().default(30),
    currency: text('currency').notNull().default('USD'),
    subtotal: numeric('subtotal', { precision: 15, scale: 2 }).notNull().default('0'),
    tax: numeric('tax', { precision: 15, scale: 2 }).notNull().default('0'),
    total: numeric('total', { precision: 15, scale: 2 }).notNull().default('0'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('recurring_invoices_account_id_idx').on(table.accountId),
    companyIdIdx: index('recurring_invoices_company_id_idx').on(table.companyId),
    customerIdIdx: index('recurring_invoices_customer_id_idx').on(table.customerId),
    // The sweep query filters on (status, next_run_date) across all tenants;
    // this composite index keeps the daily scan cheap as schedules grow.
    sweepIdx: index('recurring_invoices_sweep_idx').on(table.status, table.nextRunDate),
    // Backs the keyset list query: WHERE account_id ORDER BY created_at DESC, id DESC.
    accountCreatedAtIdx: index('recurring_invoices_account_created_at_idx').on(
      table.accountId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
  }),
);

export type RecurringInvoice = typeof recurringInvoices.$inferSelect;
export type NewRecurringInvoice = typeof recurringInvoices.$inferInsert;

// Template line items mirror invoice_line_items exactly (account_id
// denormalized for the standard NULLIF RLS idiom, position 1-based, amount
// pre-computed and stored). Cloned verbatim into invoice_line_items on each
// generated invoice.
export const recurringInvoiceLineItems = pgTable(
  'recurring_invoice_line_items',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    // FK declared in the table config (below) with an explicit short name —
    // the drizzle auto-generated name would exceed Postgres's 63-byte
    // identifier limit (squawk identifier-too-long).
    recurringInvoiceId: uuid('recurring_invoice_id').notNull(),
    position: bigint('position', { mode: 'number' }).notNull(),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 15, scale: 4 }).notNull(),
    unitPrice: numeric('unit_price', { precision: 15, scale: 2 }).notNull(),
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
    // Reporting breadcrumb back to the catalog item (null for hand-typed
    // lines). Cloned verbatim onto generated invoice lines, so the provenance
    // carries through to each occurrence. Snapshot semantics — see
    // invoice_line_items.source_item_id.
    sourceItemId: uuid('source_item_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('recurring_invoice_line_items_account_id_idx').on(table.accountId),
    recurringInvoiceIdIdx: index('recurring_invoice_line_items_recurring_invoice_id_idx').on(
      table.recurringInvoiceId,
    ),
    sourceItemIdIdx: index('recurring_invoice_line_items_source_item_id_idx').on(
      table.sourceItemId,
    ),
    recurringInvoiceFk: foreignKey({
      name: 'recurring_invoice_line_items_recurring_fk',
      columns: [table.recurringInvoiceId],
      foreignColumns: [recurringInvoices.id],
    }).onDelete('cascade'),
    sourceItemFk: foreignKey({
      name: 'recurring_line_items_source_item_fk',
      columns: [table.sourceItemId],
      foreignColumns: [items.id],
    }).onDelete('set null'),
  }),
);

export type RecurringInvoiceLineItem = typeof recurringInvoiceLineItems.$inferSelect;
export type NewRecurringInvoiceLineItem = typeof recurringInvoiceLineItems.$inferInsert;
