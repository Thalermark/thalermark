import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { companies } from './companies.js';

// A single posted ledger entry. Created by the posting helper on every
// financial state transition (invoice mark-sent / mark-paid / void;
// expense create / void; later: bank-feed import). Lines hang off via
// journal_lines.journal_entry_id and must sum to zero (debit - credit)
// per entry — enforced by a deferred constraint trigger declared in the
// RLS migration, so a multi-statement posting batch can write the header
// + lines in any order and the balance is verified at commit.
//
// source_entity_{type,id} is polymorphic — same pattern as audit_events.
// 'invoice', 'estimate', 'expense', 'payment' etc. No FK because the id
// can point at any domain table; the application layer resolves it back
// for the GL export. posted_at is the effective date of the entry
// (separate from created_at; backdated entries from bank-feed imports
// will use this). memo is human-readable context for the GL view.
//
// Entries are immutable once written — there's no PATCH endpoint. A
// posting mistake is corrected by writing a reversing entry, not by
// mutating. The RLS migration grants only INSERT + SELECT to the app
// role; UPDATE/DELETE fall through to RLS-default-deny.
export const journalEntries = pgTable(
  'journal_entries',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    sourceEntityType: text('source_entity_type').notNull(),
    sourceEntityId: uuid('source_entity_id').notNull(),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull(),
    memo: text('memo'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('journal_entries_account_id_idx').on(table.accountId),
    companyPostedAtIdx: index('journal_entries_company_posted_at_idx').on(
      table.companyId,
      table.postedAt.desc(),
    ),
    sourceIdx: index('journal_entries_source_idx').on(table.sourceEntityType, table.sourceEntityId),
  }),
);

export type JournalEntry = typeof journalEntries.$inferSelect;
export type NewJournalEntry = typeof journalEntries.$inferInsert;
