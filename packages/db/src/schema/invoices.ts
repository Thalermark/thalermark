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
import { items } from './items.js';
import { recurringInvoices } from './recurring-invoices.js';
import { taxPolicies } from './tax_policies.js';

// Invoice header. Money columns are numeric(15,2) — exact-precision arithmetic
// in Postgres, returned as string in TS to dodge JS float precision. Status is
// a plain text column ('draft' default; 'sent' / 'paid' / 'voided' set by the
// transition endpoints). issue_date and due_date are bare dates (no
// time-of-day, no TZ) to keep "due on the 15th" out of the timezone rabbit
// hole. number is unique within (account_id, company_id) — invoice numbers
// belong to the company, not the workspace.
//
// contact_id is RESTRICT on delete: contacts with invoices cannot be
// hard-deleted. The MVP path is to keep contacts around for invoice history;
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
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'restrict' }),
    number: text('number').notNull(),
    status: text('status').notNull().default('draft'),
    issueDate: date('issue_date', { mode: 'string' }).notNull(),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    currency: text('currency').notNull().default('USD'),
    subtotal: numeric('subtotal', { precision: 15, scale: 2 }).notNull().default('0'),
    tax: numeric('tax', { precision: 15, scale: 2 }).notNull().default('0'),
    total: numeric('total', { precision: 15, scale: 2 }).notNull().default('0'),
    notes: text('notes'),
    // Per-invoice overrides for whether the company's contact details print in
    // the public "from" block. Seeded from the company's show_*_on_invoice
    // defaults at create time, then independently editable while the invoice is
    // a draft. The public invoice handler gates each field on these — a false
    // flag means the value is never sent to the recipient's page, not merely
    // hidden client-side. Default true backfills existing rows to the prior
    // always-show behavior.
    showAddress: boolean('show_address').notNull().default(true),
    showPhone: boolean('show_phone').notNull().default(true),
    showEmail: boolean('show_email').notNull().default(true),
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
    // Processor fee withheld from this invoice's payment (TMC-156). Stripe
    // deposits net of its cut, so the paid posting splits the customer's gross
    // across Dr Cash (net) + Dr Merchant Processing Fees (this). Null on every
    // manual mark-paid channel and on card payments where the fee lookup failed
    // — both post the pre-TMC-156 shape (Dr Cash at gross), so null is "no fee
    // leg", not "zero fee". Persisted rather than re-fetched because
    // repostInvoicePaymentDate has to reproduce the *same* lines to reverse a
    // payment-date edit; a fee that moved between postings would leave a
    // non-zero residue in the origin period.
    processingFee: numeric('processing_fee', { precision: 15, scale: 2 }),
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
    contactIdIdx: index('invoices_contact_id_idx').on(table.contactId),
    statusIdx: index('invoices_status_idx').on(table.status),
    // Backs the keyset list query: WHERE account_id ORDER BY created_at DESC, id DESC.
    accountCreatedAtIdx: index('invoices_account_created_at_idx').on(
      table.accountId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
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
    // 4-decimal scale (not 2, unlike amount): lets a line total that doesn't
    // divide evenly by the quantity be represented exactly — e.g. $650 over 7
    // units → $92.8571/unit, which multiplies back to $650.00. See TMC-134 and
    // priceString / unitPriceFromTotal in @thalermark/validation money.ts.
    unitPrice: numeric('unit_price', { precision: 15, scale: 4 }).notNull(),
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
    // Unit-of-measure snapshot (free text, e.g. 'hour', 'sq ft') rendered next
    // to the quantity on the sent/public document. Copied from items.unit_label
    // on pick, or hand-typed. Nullable — legacy and unitless lines render a bare
    // quantity exactly as before. A snapshot like type / tax_rate_pct: editing
    // or archiving the source item never rewrites a sent doc, and it is never
    // re-read from items at render time.
    unitLabel: text('unit_label'),
    // product | service snapshot, copied from the catalog item on pick (or set
    // by hand). Drives the hidden ledger revenue split at posting: product line
    // amounts credit Product Revenue (4100), the rest Service Revenue (4000).
    // Default 'service'. App-layer enum; see items.type for the full contract.
    type: text('type').notNull().default('service'),
    // Per-line tax snapshot. taxable gates whether this line is taxed;
    // tax_rate_pct is the policy's rate copied at line time (numeric(7,4)
    // percent); tax_amount is the computed line tax (amount * rate / 100,
    // rounded). All three are stored snapshots — editing or archiving the source
    // policy never rewrites a sent invoice. The invoice header `tax` is the sum
    // of these. tax_policy_id is a provenance breadcrumb only (SET NULL on
    // policy delete, but policies archive so it survives), never re-read for
    // display — same contract as source_item_id.
    taxable: boolean('taxable').notNull().default(false),
    taxRatePct: numeric('tax_rate_pct', { precision: 7, scale: 4 }).notNull().default('0'),
    taxAmount: numeric('tax_amount', { precision: 15, scale: 2 }).notNull().default('0'),
    taxPolicyId: uuid('tax_policy_id'),
    // Reporting breadcrumb back to the catalog item this line was picked from
    // (null for hand-typed lines). ON DELETE SET NULL, but items archive rather
    // than delete, so in practice this survives. Displayed values always come
    // from the snapshot columns above, never re-read from items.
    sourceItemId: uuid('source_item_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('invoice_line_items_account_id_idx').on(table.accountId),
    invoiceIdIdx: index('invoice_line_items_invoice_id_idx').on(table.invoiceId),
    sourceItemIdIdx: index('invoice_line_items_source_item_id_idx').on(table.sourceItemId),
    // Explicit short FK name via the table-level builder — drizzle's auto name
    // and squawk's identifier-too-long rule are the R1 precedent.
    sourceItemFk: foreignKey({
      name: 'invoice_line_items_source_item_fk',
      columns: [table.sourceItemId],
      foreignColumns: [items.id],
    }).onDelete('set null'),
    taxPolicyFk: foreignKey({
      name: 'invoice_line_items_tax_policy_fk',
      columns: [table.taxPolicyId],
      foreignColumns: [taxPolicies.id],
    }).onDelete('set null'),
  }),
);

export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect;
export type NewInvoiceLineItem = typeof invoiceLineItems.$inferInsert;
