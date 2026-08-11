import { date, index, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { chartOfAccounts } from './chart_of_accounts.js';
import { companies } from './companies.js';

// Owner money events — the owner moving their OWN money in or out of the
// business. Two kinds:
//   'contribution' — "I put my own money in"   → Dr Cash 1000 / Cr Owner's Equity 3000
//   'draw'         — "I paid myself / took out" → Dr Owner's Draw 3100 / Cr Cash 1000
//
// This is what finally posts to Owner's Equity (3000) + Owner's Draw (3100):
// both are seeded into every company's chart but, before this entity, nothing
// ever touched them (an independent audit finding). Per [[project_ledger
// _decision]] the double-entry stays hidden — the user only ever sees plain
// language ("put money in" / "paid myself"), never "equity" or "draw".
//
// Header-only and the simplest of the ledger-aware entities: `kind` fully
// determines the posting, so — unlike expenses/bills — there is no category or
// payment-account picker. Cash defaults to Cash (1000), the single-Cash MVP
// assumption the COA seed documents. amount is numeric(15,2) returned as a
// decimal string ([[architecture_money_decimal_strings]]); occurred_on is a
// bare date (no TZ), matching the invoice/estimate/expense convention and
// driving the ledger posting date.
//
// Mirrors the expenses lifecycle: create posts the entry; edit = full reversal
// of the prior entry + a fresh entry in one tx (no amend-in-place); delete is
// soft (deleted_at) and posts a reversal — the row stays for history because
// the audit trail and the reversal entry both reference it by id.
export const ownerMoneyEvents = pgTable(
  'owner_money_events',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    // 'contribution' | 'draw' — app-layer enum, CHECK deferred like the
    // invoice/estimate/bill status columns. Drives the posting direction.
    kind: text('kind').notNull(),
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
    occurredOn: date('occurred_on', { mode: 'string' }).notNull(),
    // Which money account the owner put money into, or took it out of
    // (TMC-207). Nullable — events recorded before multiple accounts existed
    // resolve to the primary cash account.
    //
    // Stored, not passed at post time: postOwnerMoneyEventReversal re-derives
    // its lines from this row, so a create-time-only parameter would reverse a
    // draw taken from savings back into checking. Balanced, and wrong.
    moneyAccountId: uuid('money_account_id').references(() => chartOfAccounts.id, {
      onDelete: 'restrict',
    }),
    memo: text('memo'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('owner_money_events_account_id_idx').on(table.accountId),
    companyIdIdx: index('owner_money_events_company_id_idx').on(table.companyId),
    // Backs the keyset list query: WHERE account_id ORDER BY occurred_on DESC,
    // created_at DESC, id DESC.
    accountOccurredAtIdx: index('owner_money_events_account_occurred_at_idx').on(
      table.accountId,
      table.occurredOn.desc(),
      table.createdAt.desc(),
      table.id.desc(),
    ),
  }),
);

export type OwnerMoneyEvent = typeof ownerMoneyEvents.$inferSelect;
export type NewOwnerMoneyEvent = typeof ownerMoneyEvents.$inferInsert;
