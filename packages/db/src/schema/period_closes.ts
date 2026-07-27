import { sql } from 'drizzle-orm';
import {
  bigint,
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

// Period closes — the year-end close (TMC-159). Rolling the year's revenue and
// expense accounts into equity so they start the next year at zero, and locking
// the year so nothing can silently change it afterwards.
//
// Sole proprietors got away without one because every report re-derives net
// income from the ledger on the fly (the balance sheet's "Retained earnings
// (net income)" line). Corporations don't: Form 1120 / 1120-S Schedule L reports
// retained earnings as a REAL balance that accumulates across years.
//
// Where it rolls is entity-dependent — 3400 Retained Earnings is only seeded for
// the two corp types; sole props and partnerships close into 3000 (Owner's
// Equity / Partners' Capital). 3100 (Draw / Distributions / Dividends) closes
// into the same target, else it grows forever and the equity composition stays
// wrong. See periodCloseEquityCode in @thalermark/validation.
//
// Header-only, one active row per company per fiscal year. Re-opening a year is
// a soft delete plus a reversing journal entry — the ledger stays append-only,
// exactly like a manual adjustment ([[project_ledger_adjustments]]).
//
// Why a table at all, when the closing entry is already a journal_entries row:
// the period lock has to answer "is this instant closed?" on EVERY posting in
// the product. That wants a small indexed lookup, not a scan of journal entries
// by source type on each write. The row also carries the re-open provenance.
export const periodCloses = pgTable(
  'period_closes',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    // Calendar year closed. Non-calendar fiscal years are out of scope: companies
    // has no fiscal-year-start column and all five entity types file on a
    // calendar year by default. bigint rather than integer because squawk's
    // prefer-bigint-over-int is a CI gate here; `mode: 'number'` keeps it a plain
    // JS number on the way in and out, which a year always fits.
    fiscalYear: bigint('fiscal_year', { mode: 'number' }).notNull(),
    // The exclusive upper bound of the closed period, resolved in the COMPANY's
    // timezone ([[project_report_timezone]]) — i.e. the first instant of
    // fiscal_year + 1. A posting is locked when its posted_at is strictly before
    // the newest active close's closed_through.
    closedThrough: timestamp('closed_through', { withTimezone: true }).notNull(),
    // The closing entry itself. No FK: journal_entries is append-only and this is
    // provenance, not a dependency — the entry is also reachable the other way
    // via source_entity_type = 'year_end_close'.
    journalEntryId: uuid('journal_entry_id').notNull(),
    // What was rolled, as a decimal string ([[architecture_money_decimal_strings]]).
    // Signed: negative for a loss year.
    netIncome: numeric('net_income', { precision: 15, scale: 2 }).notNull(),
    // Which equity account absorbed it ('3000' or '3400'), snapshotted so the
    // history still reads correctly after a business-type change re-maps the COA.
    equityCode: text('equity_code').notNull(),
    // Soft delete == the year was re-opened.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('period_closes_account_id_idx').on(table.accountId),
    // The lock's read path: newest active close for a company.
    companyActiveIdx: index('period_closes_company_active_idx')
      .on(table.companyId, table.closedThrough)
      .where(sql`${table.deletedAt} is null`),
    // A year is closed at most once at a time; re-opening frees it to be closed
    // again (the soft-deleted row doesn't block).
    companyYearActiveUq: uniqueIndex('period_closes_company_year_active_uq')
      .on(table.companyId, table.fiscalYear)
      .where(sql`${table.deletedAt} is null`),
  }),
);

export type PeriodClose = typeof periodCloses.$inferSelect;
export type NewPeriodClose = typeof periodCloses.$inferInsert;
