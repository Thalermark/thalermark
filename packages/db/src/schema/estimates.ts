import {
  bigint,
  boolean,
  date,
  foreignKey,
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
import { contacts } from './contacts.js';
import { invoices } from './invoices.js';
import { items } from './items.js';
import { taxPolicies } from './tax_policies.js';

// Estimates mirror the invoice header. Status is 'draft' default with the rest
// set by the transition endpoints ('sent' / 'accepted' / 'declined' /
// 'expired'). expires_on is a bare date — read sites compute "isExpired = sent
// && expires_on < today" advisory; we don't background-sweep status until
// pg-boss is wired (see SCAFFOLDING §8.7 plan).
//
// converted_invoice_id is the link to the invoice created via the "convert"
// action; ON DELETE SET NULL so deleting an invoice doesn't cascade through
// the estimate's history. contact_id is RESTRICT to match invoices.
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
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'restrict' }),
    number: text('number').notNull(),
    status: text('status').notNull().default('draft'),
    issueDate: date('issue_date', { mode: 'string' }).notNull(),
    expiresOn: date('expires_on', { mode: 'string' }),
    currency: text('currency').notNull().default('USD'),
    subtotal: numeric('subtotal', { precision: 15, scale: 2 }).notNull().default('0'),
    tax: numeric('tax', { precision: 15, scale: 2 }).notNull().default('0'),
    total: numeric('total', { precision: 15, scale: 2 }).notNull().default('0'),
    notes: text('notes'),
    // Per-estimate overrides for whether the company's contact details print in
    // the public "from" block. Seeded from the company's show_*_on_estimate
    // defaults at create, editable while a draft. The public estimate handler
    // gates each field on these (a false flag means the value is never sent to
    // the recipient's page). Mirrors the invoices table; default true backfills
    // existing rows. NB the estimate "from" block is new — these gate it.
    showAddress: boolean('show_address').notNull().default(true),
    showPhone: boolean('show_phone').notNull().default(true),
    showEmail: boolean('show_email').notNull().default(true),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    declinedAt: timestamp('declined_at', { withTimezone: true }),
    expiredAt: timestamp('expired_at', { withTimezone: true }),
    convertedInvoiceId: uuid('converted_invoice_id').references(() => invoices.id, {
      onDelete: 'set null',
    }),
    publicToken: text('public_token'),
    // Same three as invoices — an estimate that never arrived is a job that
    // never got quoted, and it failed just as silently (TMC-226).
    deliveryStatus: text('delivery_status'),
    deliveryDetail: text('delivery_detail'),
    deliveryUpdatedAt: timestamp('delivery_updated_at', { withTimezone: true }),
    deliveryMessageId: text('delivery_message_id'),
    viewedAt: timestamp('viewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('estimates_account_id_idx').on(table.accountId),
    companyIdIdx: index('estimates_company_id_idx').on(table.companyId),
    contactIdIdx: index('estimates_contact_id_idx').on(table.contactId),
    statusIdx: index('estimates_status_idx').on(table.status),
    // Backs the keyset list query: WHERE account_id ORDER BY created_at DESC, id DESC.
    accountCreatedAtIdx: index('estimates_account_created_at_idx').on(
      table.accountId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
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
    // 4-decimal scale — sibling of invoice_line_items.unit_price (see TMC-134).
    unitPrice: numeric('unit_price', { precision: 15, scale: 4 }).notNull(),
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
    // Unit-of-measure snapshot (free text, e.g. 'hour') — carried onto the
    // converted invoice line. Nullable; see invoice_line_items.unit_label.
    unitLabel: text('unit_label'),
    // product | service snapshot — carried onto the converted invoice line so
    // the revenue split survives convert-to-invoice. See invoice_line_items.type.
    type: text('type').notNull().default('service'),
    // Per-line tax snapshot — see invoice_line_items for the full contract.
    taxable: boolean('taxable').notNull().default(false),
    taxRatePct: numeric('tax_rate_pct', { precision: 7, scale: 4 }).notNull().default('0'),
    taxAmount: numeric('tax_amount', { precision: 15, scale: 2 }).notNull().default('0'),
    taxPolicyId: uuid('tax_policy_id'),
    // Reporting breadcrumb back to the catalog item (null for hand-typed
    // lines). Snapshot semantics — see invoice_line_items.source_item_id.
    sourceItemId: uuid('source_item_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('estimate_line_items_account_id_idx').on(table.accountId),
    estimateIdIdx: index('estimate_line_items_estimate_id_idx').on(table.estimateId),
    sourceItemIdIdx: index('estimate_line_items_source_item_id_idx').on(table.sourceItemId),
    sourceItemFk: foreignKey({
      name: 'estimate_line_items_source_item_fk',
      columns: [table.sourceItemId],
      foreignColumns: [items.id],
    }).onDelete('set null'),
    taxPolicyFk: foreignKey({
      name: 'estimate_line_items_tax_policy_fk',
      columns: [table.taxPolicyId],
      foreignColumns: [taxPolicies.id],
    }).onDelete('set null'),
  }),
);

export type EstimateLineItem = typeof estimateLineItems.$inferSelect;
export type NewEstimateLineItem = typeof estimateLineItems.$inferInsert;
