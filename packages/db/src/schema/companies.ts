import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';

export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // Business entity type — picked at company creation; drives which
    // chart-of-accounts gets seeded and which tax reports surface. MVP
    // seeds the sole-prop COA regardless of value (other types fall
    // back to sole-prop until v1.x adds their seeds + reports). Null
    // is treated as 'sole_prop' by the application layer so pre-ledger
    // rows keep working. Allowed values enforced at the app layer for
    // now; CHECK constraint deferred until the wizard slice locks the
    // enum.
    businessType: text('business_type'),
    // When this business counts income — 'cash' | 'accrual' (TMC-155).
    // Orthogonal to business_type: Schedule C asks them separately (entity
    // type, then line F), and a sole proprietor may elect either. NOT NULL
    // DEFAULT 'cash' because that's the correct answer for effectively the
    // whole audience, and because a null basis on a tax export is worse than a
    // wrong-but-visible one.
    //
    // The GL is always accrual — this selects only the reporting lens applied
    // at read time, the same one-ledger model QuickBooks and Xero use. Never
    // asked at onboarding (users don't pick accounting concepts); Settings
    // frames it as "When do you count income?". App-layer enum, CHECK deferred
    // like business_type.
    accountingMethod: text('accounting_method').notNull().default('cash'),
    // IANA zone the company's reporting day boundaries are computed in
    // (TMC-157). Everything date-windowed — the tax year, report from/to,
    // as-of — resolves local midnight through this rather than assuming UTC,
    // so a payment taken at 8pm on 31 Dec lands in the year the operator
    // thinks it did.
    //
    // Defaults to 'UTC', which is exactly the old behaviour: any other default
    // would silently *move* existing companies' figures on migration. Stored
    // as text and validated at the app boundary (isValidTimeZone) rather than
    // constrained in the DB — the tz database gains and renames zones, and a
    // CHECK would go stale against it.
    timezone: text('timezone').notNull().default('UTC'),
    // Business identity surfaced on invoices/estimates: a free-text postal
    // address and a contact phone. Both nullable — pre-existing companies and
    // freshly-created ones start null, and the public invoice simply omits the
    // sender block until they're set. Collected lazily (Settings → Business +
    // a dashboard nudge), never gated at signup, so the <60s first-invoice path
    // stays intact. Free-text on purpose: trades/freelancers' "address" is
    // whatever reads right on an invoice, not a structured record.
    businessAddress: text('business_address'),
    businessPhone: text('business_phone'),
    // Customer-facing business email shown in the public invoice "from" block
    // (distinct from reply_to_email, which only sets the Reply-To header on
    // outbound mail). Nullable, free-text-ish — the public invoice omits it
    // until set. Collected lazily in Settings → Business alongside address/phone.
    businessEmail: text('business_email'),
    // Per-field defaults for whether the company's contact details print on the
    // public invoice "from" block. These seed each new invoice's own show_*
    // flags at creation; the public invoice reads the *invoice's* flag, not
    // these (so a later settings change never rewrites already-issued invoices).
    // Default true preserves the prior behavior (address/phone always showed
    // when set); email defaults true too so a filled business email surfaces
    // without a second opt-in.
    showAddressOnInvoice: boolean('show_address_on_invoice').notNull().default(true),
    showPhoneOnInvoice: boolean('show_phone_on_invoice').notNull().default(true),
    showEmailOnInvoice: boolean('show_email_on_invoice').notNull().default(true),
    // The estimate-side equivalents. Deliberately separate from the invoice
    // flags above (a business may want contact on invoices but not estimates,
    // or vice versa); each seeds the matching show_* flag on a new estimate.
    // business_email above is shared — these gate whether it prints on estimates.
    showAddressOnEstimate: boolean('show_address_on_estimate').notNull().default(true),
    showPhoneOnEstimate: boolean('show_phone_on_estimate').notNull().default(true),
    showEmailOnEstimate: boolean('show_email_on_estimate').notNull().default(true),
    // Object-storage key for the company logo shown on invoices/estimates.
    // Same storage abstraction as receipts (S3/R2/MinIO/local-FS); the bytes
    // never live in Postgres, only this key. Nullable — no logo by default, and
    // the public invoice renders the text-only sender block until one's set.
    // The public invoice handler turns this into a fresh signed URL per page
    // load, so there's no stored/expiring URL to manage.
    logoStorageKey: text('logo_storage_key'),
    // Customer-facing reply address. When set, invoice/estimate emails carry a
    // Reply-To pointing here so a customer's reply reaches the business, not
    // the platform sender. Null → no Reply-To header (current default). The
    // From envelope address always stays on the DNS-verified EMAIL_FROM domain
    // (Resend won't send otherwise); only the From *display name* is swapped to
    // the company name. True per-tenant verified sending domains (full
    // white-label) are a separate, later slice.
    replyToEmail: text('reply_to_email'),
    // Stripe Connect (SaaS multi-tenant payment routing). Lazily populated
    // when the company owner kicks off onboarding from /settings/payments —
    // self-host operators using a single STRIPE_SECRET_KEY leave these null
    // and the 8.5c self-host pay flow remains correct for them.
    // charges_enabled is the gate for whether 8.5e routes payments to this
    // connected account; details_submitted surfaces the "review in progress"
    // intermediate state Stripe puts a freshly-onboarded account in.
    stripeConnectAccountId: text('stripe_connect_account_id'),
    stripeConnectChargesEnabled: boolean('stripe_connect_charges_enabled').notNull().default(false),
    stripeConnectDetailsSubmitted: boolean('stripe_connect_details_submitted')
      .notNull()
      .default(false),
    // Offline / manual payment methods, surfaced as "pay me directly"
    // instructions on the public invoice. Display-only — the app can't process
    // or verify these (Venmo/Zelle have no usable third-party API), so the
    // business confirms receipt via the existing manual mark-paid transition,
    // never the customer. Cash/check are on/off booleans; venmo/zelle are
    // considered enabled when their handle/contact is non-empty. Check carries
    // an optional payable-to name + mailing address.
    paymentCashEnabled: boolean('payment_cash_enabled').notNull().default(false),
    paymentCheckEnabled: boolean('payment_check_enabled').notNull().default(false),
    paymentCheckPayableTo: text('payment_check_payable_to'),
    paymentCheckAddress: text('payment_check_address'),
    paymentVenmoHandle: text('payment_venmo_handle'),
    paymentZelleContact: text('payment_zelle_contact'),
    // Cash-flow nudges (AI insight) cache. The reasoning-role LLM writes
    // plain-English nudges from deterministic ledger signals; we cache them
    // here so the dashboard doesn't re-run the model on every view.
    // nudges_input_hash is a hash of those signals — the route regenerates only
    // when it changes (new transactions, a newly-overdue invoice, a month
    // rollover), so invalidation is input-driven with no TTL. All null until
    // the first generation. JIT note: when a second cached insight (anomaly /
    // late-payer) lands, promote these to a company_insights table keyed by type.
    cashFlowNudges: jsonb('cash_flow_nudges'),
    nudgesInputHash: text('nudges_input_hash'),
    nudgesGeneratedAt: timestamp('nudges_generated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('companies_account_id_idx').on(table.accountId),
    stripeConnectAccountIdUq: uniqueIndex('companies_stripe_connect_account_id_uq').on(
      table.stripeConnectAccountId,
    ),
  }),
);

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
