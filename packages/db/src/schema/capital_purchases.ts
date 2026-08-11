import { bigint, date, index, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { chartOfAccounts } from './chart_of_accounts.js';
import { companies } from './companies.js';
import { contacts } from './contacts.js';

// Capital purchases — "big purchases" in plain language: durable gear the
// business buys and uses for years (a mower, trailer, truck). The honest
// accounting the MVP couldn't do before: this is a capital ASSET (not an
// expense), optionally bought with a LOAN (not accounts payable), and either
// written off this year (§179) or depreciated over its life. Per
// [[project_ledger_decision]] + [[project_plain_language_money_out]] the
// double-entry AND the accountant vocabulary stay hidden — the user answers
// "what did you buy / how much / paid now or over time / how to handle on taxes"
// and never sees "fixed asset", "capitalize", "note payable", or "depreciate".
//
// Captured from a branch in the Expenses flow ("will you use this for years?").
// Header-only, like its expenses/bills siblings. The postings live in
// lib/ledger.ts (capitalPurchaseLines): Dr 1500 Vehicles & Equipment = amount;
// Cr Cash 1000 = paid now (down payment / full); Cr 2700 Loans Payable =
// financed remainder; plus, when tax_treatment='deduct_now', Dr 6350 / Cr 1900
// for the full §179 write-off. The per-purchase loan balance is DERIVED from the
// ledger (postings on 2700 tagged with this row's id), the bills/owner-money
// source-group pattern — there is no balance column. Edit/clear follow the
// reverse-then-repost / soft-delete+reverse discipline.
export const capitalPurchases = pgTable(
  'capital_purchases',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    // What they bought, in their own words ("Mower"). The display label.
    description: text('description').notNull(),
    // Total cost (the capitalized amount). numeric(15,2) as a decimal string
    // ([[architecture_money_decimal_strings]]).
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
    purchaseDate: date('purchase_date', { mode: 'string' }).notNull(),
    // 'paid_in_full' | 'financed' — app-layer enum (CHECK deferred like the
    // invoice/bill status columns). Drives whether a loan leg is posted.
    funding: text('funding').notNull(),
    // Cash paid up front. 0 for a fully financed purchase; == amount for
    // paid_in_full. The financed remainder (amount − down_payment) becomes the
    // loan.
    downPayment: numeric('down_payment', { precision: 15, scale: 2 }).notNull().default('0'),
    // Which money account the down payment came out of (TMC-207) — a mower is
    // as likely to go on the card as out of checking. Nullable; purchases made
    // before multiple accounts existed resolve to the primary cash account.
    //
    // Stored, not passed at post time: postCapitalPurchaseReversal re-derives
    // its lines from this row via capitalPurchaseLines and flips them, so a
    // create-time-only parameter would credit the card and debit cash on the
    // way back out.
    paymentAccountId: uuid('payment_account_id').references(() => chartOfAccounts.id, {
      onDelete: 'restrict',
    }),
    // 'deduct_now' | 'spread' — the plain tax choice ("deduct it all this year"
    // vs "spread it out"). deduct_now posts the full §179 write-off at purchase;
    // spread leaves the asset on the books for the (deferred) yearly depreciation.
    taxTreatment: text('tax_treatment').notNull(),
    // Useful life in years for the 'spread' path's depreciation schedule. A
    // sensible default (5) the user never has to think about; surfaced only as
    // the plain answer ("about $X/year for 5 years").
    usefulLifeYears: bigint('useful_life_years', { mode: 'number' }).notNull().default(5),
    // Who they bought from (optional) — a contact with is_vendor set, like bills.
    vendorContactId: uuid('vendor_contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    memo: text('memo'),
    // --- Carried-over assets -------------------------------------------------
    // An asset that was already part-way through its life when it arrived on
    // these books: an accountant entering a mower bought two years ago, or a
    // sole proprietor incorporating (§351 carryover basis — the corporation
    // steps into the transferor's shoes, same cost, same life, same clock).
    //
    // What was already written off ELSEWHERE. Schedule metadata only: it caps
    // how much this company may still take. The accumulated depreciation itself
    // reaches these books through the opening balance's Cr 1900, so counting it
    // here as well would double it.
    priorAccumulatedDepreciation: numeric('prior_accumulated_depreciation', {
      precision: 15,
      scale: 2,
    })
      .notNull()
      .default('0'),
    // First year THIS company posts depreciation for. Null derives it from
    // purchase_date, which is exactly today's behaviour — so every existing row
    // is untouched and an ordinary purchase needs no thought.
    depreciationStartYear: bigint('depreciation_start_year', { mode: 'number' }),
    // Provenance, and load-bearing rather than decorative: a transferred purchase
    // never had a create posting (it arrives through an opening balance, not a
    // Dr 1500 / Cr Cash), so the delete path must not try to reverse one.
    // Deliberately no FK — it points at a row in another company's books and has
    // to survive independently of it.
    transferredFromPurchaseId: uuid('transferred_from_purchase_id'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('capital_purchases_account_id_idx').on(table.accountId),
    companyIdIdx: index('capital_purchases_company_id_idx').on(table.companyId),
    vendorContactIdIdx: index('capital_purchases_vendor_contact_id_idx').on(table.vendorContactId),
    // Backs the keyset list query: WHERE account_id ORDER BY purchase_date DESC,
    // created_at DESC, id DESC.
    accountPurchaseAtIdx: index('capital_purchases_account_purchase_at_idx').on(
      table.accountId,
      table.purchaseDate.desc(),
      table.createdAt.desc(),
      table.id.desc(),
    ),
  }),
);

export type CapitalPurchase = typeof capitalPurchases.$inferSelect;
export type NewCapitalPurchase = typeof capitalPurchases.$inferInsert;
