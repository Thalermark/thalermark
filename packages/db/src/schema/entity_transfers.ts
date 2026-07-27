import { sql } from 'drizzle-orm';
import {
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { companies } from './companies.js';

// One business handing its books to another — almost always a sole proprietor
// incorporating. The two are different taxpayers with different EINs: the
// predecessor files a final Schedule C for the stub period, the successor files
// its own return from the transfer date. QuickBooks and Xero both require a new
// company file for exactly this reason; Xero is blunt that the old data "doesn't
// belong to the new company".
//
// A table rather than a predecessor_company_id column on companies, because the
// interesting part is not the link but the FACTS of the handoff: when it took
// effect, what the user decided about outstanding invoices, and the two journal
// entries that moved the balances. Those are what make it auditable, explicable
// months later, and reversible.
//
// The two entries are the whole mechanism:
//   OUT — on the predecessor, zeroing every transferring asset and liability
//         against equity. Because the balance sheet computes total equity as
//         equity accounts + net income, and the identity gives E + NI = A − L,
//         the plug drives total equity to exactly zero WITHOUT touching the P&L.
//         The stub-period profit and loss survives for the final return, which
//         is why no partial-year close is needed.
//   IN  — the mirror on the successor, resolved by account CODE against its own
//         chart (codes are stable across every entity type by design).
export const entityTransfers = pgTable(
  'entity_transfers',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    // The business that stopped, and the one that carried on.
    predecessorCompanyId: uuid('predecessor_company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    successorCompanyId: uuid('successor_company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    // The date the new business took over. Bare calendar date; the boundary
    // instant is resolved in the company's timezone at posting time.
    effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
    // 'stay' | 'transfer' — who collects the invoices already sent but unpaid.
    // Both are legitimate and they produce different opening balances, so the
    // user is asked rather than guessed at. 'stay' is the common answer: the old
    // business billed the work, so the old business banks the cheque (which is
    // why retirement permits settlement, see lib/company-lock.ts).
    openInvoicesDisposition: text('open_invoices_disposition').notNull().default('stay'),
    // The two postings. No FK: journal_entries is append-only and this is
    // provenance, not a dependency — the entries are also reachable the other
    // way via source_entity_type.
    outJournalEntryId: uuid('out_journal_entry_id').notNull(),
    inJournalEntryId: uuid('in_journal_entry_id').notNull(),
    // What was copied and which assets crossed — the answers to the wizard's
    // questions, kept so the handoff can be explained long afterwards.
    options: jsonb('options'),
    // Set when the handoff was undone. Not a soft delete: the transfer really
    // happened and its reversing entries are on both ledgers.
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('entity_transfers_account_id_idx').on(table.accountId),
    predecessorIdx: index('entity_transfers_predecessor_idx').on(table.predecessorCompanyId),
    // A company can succeed at most one predecessor at a time. Reversing frees
    // it, so the index is over live rows only.
    successorActiveUq: uniqueIndex('entity_transfers_successor_active_uq')
      .on(table.successorCompanyId)
      .where(sql`${table.reversedAt} is null`),
  }),
);

export type EntityTransfer = typeof entityTransfers.$inferSelect;
export type NewEntityTransfer = typeof entityTransfers.$inferInsert;
