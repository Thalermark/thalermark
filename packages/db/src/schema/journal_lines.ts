import { index, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { chartOfAccounts } from './chart_of_accounts.js';
import { journalEntries } from './journal_entries.js';

// One debit-or-credit posting against one COA account, owned by a
// journal_entry. side is 'debit' | 'credit' (CHECK in the migration);
// amount is positive numeric(15,2) so the balance invariant reads as a
// signed sum of CASE side WHEN 'debit' THEN amount ELSE -amount END.
// Storing side + positive amount keeps every report (trial balance, GL,
// P&L, balance sheet) able to render debit/credit columns without
// re-deriving sign on read.
//
// account_id is the tenant denorm — same NULLIF RLS idiom as the rest of
// the schema (uniform, dodges a join through journal_entries on every
// policy check). coa_account_id is the FK to chart_of_accounts; a row
// can't post against a deleted COA account so the FK is RESTRICT, and
// COA accounts themselves are deactivated via is_active rather than
// deleted in practice.
//
// currency mirrors the invoice/estimate convention (USD default in MVP;
// the column is here so a v1.x multi-currency change is additive on the
// money columns rather than a column add).
//
// Like journal_entries, lines are immutable post-write — mistakes get
// corrected with a reversing entry. The RLS migration grants only INSERT
// + SELECT.
export const journalLines = pgTable(
  'journal_lines',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    coaAccountId: uuid('coa_account_id')
      .notNull()
      .references(() => chartOfAccounts.id, { onDelete: 'restrict' }),
    side: text('side').notNull(),
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
    currency: text('currency').notNull().default('USD'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('journal_lines_account_id_idx').on(table.accountId),
    journalEntryIdIdx: index('journal_lines_journal_entry_id_idx').on(table.journalEntryId),
    coaAccountIdIdx: index('journal_lines_coa_account_id_idx').on(table.coaAccountId),
  }),
);

export type JournalLine = typeof journalLines.$inferSelect;
export type NewJournalLine = typeof journalLines.$inferInsert;
