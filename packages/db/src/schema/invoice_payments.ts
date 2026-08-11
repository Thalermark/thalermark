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
import { chartOfAccounts } from './chart_of_accounts.js';
import { companies } from './companies.js';
import { invoices } from './invoices.js';

// Money received against an invoice (TMC-187). One row per receipt, not one
// flag per invoice.
//
// Settlement used to live on the invoice header — paid_at, payment_method,
// payment_reference, processing_fee — with a single mark-paid transition
// flipping the whole document. That made an invoice paid or unpaid with nothing
// in between, in a product whose stated audience takes 50% down. A landscaper
// could not record "the customer paid $500 of $1,200" without either lying (mark
// it paid) or lying differently (leave it open).
//
// The header columns are deliberately LEFT IN PLACE and still written on the
// full-payment path, so every existing reader keeps working untouched. They are
// now a denormalised convenience: these rows are the truth, and
// outstandingCents() derives status from sum(amount) vs the invoice total.
//
// WHY A PAYMENT REQUIRES AN ISSUED INVOICE. A payment relieves accounts
// receivable, and a draft has no receivable — nothing has been posted for it to
// pay down. Taking a deposit against an unissued invoice would need an
// unearned-revenue liability, which is a real chart-of-accounts decision across
// five entity seeds and is NOT part of this change. So: issue the invoice, then
// take the deposit. The route enforces it and the reason is worth keeping,
// because "why can't I record a payment on a draft?" is the obvious question.
//
// SIGNED AMOUNTS. A refund or a credit note is a NEGATIVE row, not a second
// concept — the ledger posting is the same lines with the sides flipped, and AR
// nets correctly for free. This is why `amount` carries no CHECK (amount > 0).
export const invoicePayments = pgTable(
  'invoice_payments',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    // CASCADE, unlike time_entries.billed_invoice_id which is SET NULL. A
    // payment has no meaning without the invoice it settles — an orphaned
    // receipt pointing at nothing is not a record worth keeping, where an
    // orphaned hour worked still is. There is no invoice DELETE endpoint today,
    // so this is a data-integrity backstop rather than a live path.
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    // Signed. Positive = money in; negative = a refund or credit note. Same
    // numeric(15,2) as every other money column, crossing the API as a decimal
    // string.
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
    // A bare calendar date, like invoices.issue_date and time_entries.entry_date
    // — when the money actually arrived, which is the ledger date. Not a
    // timestamp: "paid on the 14th" must not drift across a timezone boundary
    // and land the cash in the wrong month.
    receivedOn: date('received_on', { mode: 'string' }).notNull(),
    // How the money arrived: 'cash' | 'check' | 'venmo' | 'zelle' | 'other' from
    // the manual picker, or 'stripe' stamped by the payment_intent.succeeded
    // webhook. App-layer enum, CHECK deferred — same treatment as
    // invoices.payment_method, which this supersedes.
    method: text('method').notNull(),
    // Optional free text: a check number, a confirmation code.
    reference: text('reference'),
    // The processor's cut withheld from THIS receipt (TMC-156 semantics, now
    // per-payment rather than per-invoice). Stripe deposits net, so the posting
    // splits the customer's gross across Dr Cash (amount - fee) and Dr Merchant
    // Processing Fees (fee). Null means "no fee leg", not "zero fee".
    //
    // Persisted rather than re-fetched for the reason the header column was: a
    // reversal has to reproduce the SAME lines it is cancelling, and a fee that
    // moved between postings would leave a non-zero residue in the origin
    // period.
    processingFee: numeric('processing_fee', { precision: 15, scale: 2 }),
    // Set only on the Stripe path. Carries the idempotency guarantee: the
    // webhook can fire more than once for one intent, and the unique index below
    // turns a duplicate delivery into a no-op instead of a double credit.
    stripePaymentIntentId: text('stripe_payment_intent_id'),
    // The MANUAL path's equivalent of that guarantee (TMC-218).
    //
    // Stripe's duplicate delivery had an index; a human's double-click had
    // nothing. The record-payment button showed no pending state, so a slow
    // request read as a dead click and invited a second one — and two identical
    // receipts is a silent books error, an invoice reporting itself overpaid.
    // Two tabs, a back-button resubmit and a flaky-network retry reach the same
    // place, which is why disabling the button is not on its own a fix.
    //
    // The client mints this per form render, so retrying the SAME submission is
    // a no-op while a genuine second payment of the same amount on the same day
    // — a real thing, two $50 cash instalments — carries a different key and is
    // recorded. Nullable: every receipt written before this column existed, and
    // every Stripe one, leaves it null.
    idempotencyKey: text('idempotency_key'),
    // Which of the company's money accounts this receipt landed in (TMC-207).
    // Nullable: every receipt written before multiple accounts existed resolves
    // to the primary cash account, which is where it actually went.
    //
    // Stored rather than passed at post time because postInvoicePaymentReversal
    // RE-DERIVES its lines from this row and flips them — it never reads the
    // original journal entry back. A create-time-only parameter would therefore
    // reverse against the default account: money credited out of one account and
    // debited back into another, balanced and wrong.
    depositAccountId: uuid('deposit_account_id').references(() => chartOfAccounts.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('invoice_payments_account_id_idx').on(table.accountId),
    // Backs the hot query: every payment for one invoice, to sum against its
    // total and render the receipt list. Ordered by date so the list read comes
    // back sorted off the index.
    invoiceIdIdx: index('invoice_payments_invoice_id_idx').on(
      table.accountId,
      table.invoiceId,
      table.receivedOn,
    ),
    // Backs the cash-basis reporting reads, which ask "what came in between
    // these two dates" across the whole company.
    companyReceivedOnIdx: index('invoice_payments_company_received_on_idx').on(
      table.accountId,
      table.companyId,
      table.receivedOn,
    ),
    // Stripe idempotency. A webhook can be delivered more than once for the same
    // intent, and without this a retry credits the customer twice — the failure
    // mode is silent and only shows up as an invoice that says it overpaid.
    // Partial, because every manual payment leaves the column null and they must
    // not collide with each other.
    stripeIntentUq: uniqueIndex('invoice_payments_stripe_intent_uq')
      .on(table.stripePaymentIntentId)
      .where(sql`${table.stripePaymentIntentId} is not null`),
    // Manual idempotency, scoped to the account so one tenant's key can never
    // collide with another's. Partial for the same reason as the Stripe index
    // above: the column is null on every legacy and Stripe row, and nulls must
    // not collide with each other.
    idempotencyUq: uniqueIndex('invoice_payments_idempotency_uq')
      .on(table.accountId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  }),
);

export type InvoicePayment = typeof invoicePayments.$inferSelect;
export type NewInvoicePayment = typeof invoicePayments.$inferInsert;
