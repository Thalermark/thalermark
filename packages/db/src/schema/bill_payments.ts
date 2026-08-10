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
import { bills } from './bills.js';
import { chartOfAccounts } from './chart_of_accounts.js';
import { companies } from './companies.js';

// Money paid against a vendor bill (TMC-192) — the accounts-payable mirror of
// invoice_payments. One row per payment, not one flag per bill.
//
// Everything invoice_payments says applies here in reverse: a bill was 'open'
// or 'paid' with nothing in between, so a vendor deposit, a progress payment on
// a materials account, or a partial refund from a supplier had nowhere to live.
// The header columns (paid_at, payment_method, payment_reference,
// payment_account_id) are LEFT IN PLACE and still maintained, so the AP aging
// report, both clients and every existing reader keep working untouched.
// Nothing is backfilled: a bill already marked paid keeps its header stamps,
// has no payment rows, and reads exactly as it did before.
//
// WHY THIS IS NOT A COPY OF THE INVOICE TABLE. An invoice always settles into
// Cash (1000) by construction. A bill settles from whichever account the money
// left, and that belongs to the PAYMENT rather than the bill — paying half from
// the business account and half in cash is the case the column exists for.
// Hence payment_account_id below, which invoice_payments has no need of.
//
// Today it always resolves to Cash, because the chart of accounts is seed-only
// (nothing creates a chart_of_accounts row) and Cash is the only account in the
// seed money can leave from. The clients therefore offer no picker — one would
// list Accounts Receivable and Accumulated Depreciation as places to pay a
// vendor from. The column is the part that has to exist first: it is written
// per payment now, so a second bank account is a UI change and a widened check
// in routes/bills.ts rather than a migration against live payment history.
//
// No stripe_payment_intent_id and no processing_fee, unlike the invoice side:
// you do not pay a vendor through your own Stripe account, so neither the
// idempotency guarantee nor the fee split has anything to key off here.
//
// SIGNED AMOUNTS. A refund from the vendor is a NEGATIVE row, not a second
// concept — the ledger posting is the same two lines with the sides flipped, so
// AP nets correctly for free. This is why `amount` carries no CHECK.
export const billPayments = pgTable(
  'bill_payments',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    // CASCADE, matching invoice_payments: a payment has no meaning without the
    // bill it settles. There is no bill DELETE endpoint today, so this is a
    // data-integrity backstop rather than a live path.
    billId: uuid('bill_id')
      .notNull()
      .references(() => bills.id, { onDelete: 'cascade' }),
    // The asset the money actually left from, per payment. RESTRICT like
    // bills.payment_account_id — a COA row with postings against it must not
    // vanish underneath them. Nullable: resolved to the company's Cash (1000)
    // by the route when the client does not pick one, and stored resolved, so
    // a null here means the row predates nothing — the route never writes one.
    paymentAccountId: uuid('payment_account_id').references(() => chartOfAccounts.id, {
      onDelete: 'restrict',
    }),
    // Signed. Positive = money out to the vendor; negative = a refund back from
    // them. Same numeric(15,2) as every other money column, crossing the API as
    // a decimal string.
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
    // A bare calendar date — when the money actually left, which is the ledger
    // date. Not a timestamp: "paid on the 14th" must not drift across a
    // timezone boundary and land the payment in the wrong month.
    paidOn: date('paid_on', { mode: 'string' }).notNull(),
    // How the money left: 'cash' | 'check' | 'venmo' | 'zelle' | 'other'. No
    // 'stripe' — that is the collecting side, not the paying side. App-layer
    // enum, CHECK deferred, same treatment as bills.payment_method.
    method: text('method').notNull(),
    // Optional free text: a check number, a confirmation code.
    reference: text('reference'),
    // Double-click protection for the manual path, mirroring the invoice side
    // (TMC-218). There is no Stripe leg here — a bill is money you pay out — so
    // this is the only idempotency this table has. Client-minted per form
    // render: a retried submission is a no-op, a genuinely repeated payment of
    // the same amount on the same day carries a different key and is recorded.
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('bill_payments_account_id_idx').on(table.accountId),
    // Backs the hot query: every payment for one bill, to sum against its
    // amount and render the list. Ordered by date so the read comes back sorted
    // off the index.
    billIdIdx: index('bill_payments_bill_id_idx').on(table.accountId, table.billId, table.paidOn),
    // Backs the cash-basis reporting reads, which ask "what went out between
    // these two dates" across the whole company.
    companyPaidOnIdx: index('bill_payments_company_paid_on_idx').on(
      table.accountId,
      table.companyId,
      table.paidOn,
    ),
    // Account-scoped and partial, matching invoice_payments_idempotency_uq:
    // nulls (every row written before this column existed) must not collide.
    idempotencyUq: uniqueIndex('bill_payments_idempotency_uq')
      .on(table.accountId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  }),
);

export type BillPayment = typeof billPayments.$inferSelect;
export type NewBillPayment = typeof billPayments.$inferInsert;
