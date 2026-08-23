import {
  bigint,
  date,
  index,
  numeric,
  pgTable,
  text,
  time,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { companies } from './companies.js';
import { invoices } from './invoices.js';
import { items } from './items.js';
import { jobs } from './jobs.js';
import { memberships } from './memberships.js';

// Hours worked on a job (TMC-180). Two payoffs and they are not equal: hours
// become invoice lines at a rate — the reason to build it, because the invoice
// then fills itself in — and hours complete job margin, which receipts alone
// leave shallow. A landscaper billing $900 against $140 of materials is not
// making $760; he is making $760 minus two days of his own time.
//
// THE OWNER'S OWN HOURS ARE NOT AN EXPENSE. A sole proprietor cannot deduct his
// own labour: no payroll, no wage expense, no journal entry — money taken out is
// an owner's draw against equity. So nothing here posts to the ledger and
// nothing here reaches a tax worksheet. Employee and contractor hours are the
// opposite case and already have homes (payroll, or contract labour on Schedule
// C line 11). What tracked time buys is a reporting lens — effective hourly,
// (billed - costs) / hours — never a GL posting.
export const timeEntries = pgTable(
  'time_entries',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    // NOT NULL, and the whole premise of the jobs entity: the container has to
    // exist before the work does. There is deliberately no "unassigned time"
    // state — that would just recreate the problem jobs were added to solve.
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    // A bare calendar date, like invoices.issue_date. When the work happened,
    // not when it was typed in — reconstructing "3 hours yesterday" has to be
    // as easy as running a timer live.
    entryDate: date('entry_date', { mode: 'string' }).notNull(),
    // Minutes, not hours: the smallest unit anyone enters, and integral, so no
    // rounding is baked into storage. Hours are derived at billing time via
    // priceString in @thalermark/validation, the same rounding every other line
    // goes through. bigint rather than integer to satisfy squawk.
    //
    // NULLABLE SINCE TMC-264, and the reasoning above is unchanged — minutes is
    // still the smallest unit, still integral, still the only rounding step. It
    // is now merely OPTIONAL on a job that does not bill by it. A dog sitter
    // logging "1 visit" has a duration only if she chooses to record one, and
    // its sole consumer there is effective-hourly, which already returns null
    // (rendering a dash) when it has no denominator.
    //
    // Required on a job billing by the hour, enforced in @thalermark/validation
    // rather than by a CHECK — see the migration for why.
    minutes: bigint('minutes', { mode: 'number' }),
    // The count in the JOB's billing unit (TMC-264). Null on an hourly job,
    // where the count IS the duration and is derived from minutes at billing
    // time exactly as before.
    //
    // WHY A REAL COLUMN AND NOT A LABEL. Three 30-minute visits are minutes =
    // 90. A quantity still derived from minutes would put "1.5 visits" on the
    // invoice — wrong in a way the customer can see, which is what makes this a
    // storage change rather than a copy change.
    //
    // numeric(15,4) matches invoice_line_items.quantity exactly, so a billed
    // visit and a hand-typed line cannot round differently.
    quantity: numeric('quantity', { precision: 15, scale: 4 }),
    // The clock times a time-card entry was typed as (TMC-265). Both null for a
    // typed duration or a stopwatch entry, which is every entry before this.
    //
    // Bare `time`, no zone, for the same reason entryDate is a bare `date`:
    // these are the BUSINESS's wall clock (TMC-258). A care giver's shift is
    // 7:00am to 3:00pm on the invoice regardless of where the person reading it
    // is sitting, and attaching a zone would let the pair drift against the
    // entryDate they belong to.
    //
    // Kept rather than discarded after computing minutes because TMC-263
    // established that WHEN the work happened matters on the customer's
    // invoice: "7:00am to 3:00pm" survives a client questioning the bill far
    // better than "8 hours" does.
    startTime: time('start_time'),
    endTime: time('end_time'),
    note: text('note'),
    // Snapshot of the billing rate, at invoice_line_items.unit_price scale
    // (15,4) so hours x rate lands exactly where a hand-typed line would.
    // Nullable: time logged for margin only, with nothing to bill, is a real
    // and common case.
    rate: numeric('rate', { precision: 15, scale: 4 }),
    // Breadcrumb to the catalog item the rate came from, mirroring
    // invoice_line_items.source_item_id. Display always comes from the snapshot
    // above; this is for reporting only. SET NULL — items archive rather than
    // delete, so this survives in practice.
    sourceItemId: uuid('source_item_id').references(() => items.id, { onDelete: 'set null' }),
    // Set when the entry is billed onto an invoice; NULL means unbilled and is
    // what the billing picker filters on.
    //
    // SET NULL, DELIBERATELY NOT CASCADE — and this is the one place where this
    // table disagrees with expense_allocations, which cascades. Deleting an
    // invoice should return the hours to unbilled so they can be billed again.
    // Cascading would destroy the record that the work ever happened, which is
    // a far worse loss than a dropped attribution.
    billedInvoiceId: uuid('billed_invoice_id').references(() => invoices.id, {
      onDelete: 'set null',
    }),
    // Who worked. Nullable — on a single-operator workspace it is noise, and
    // backfilling it would be a guess.
    membershipId: uuid('membership_id').references(() => memberships.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('time_entries_account_id_idx').on(table.accountId),
    // Backs the job detail view and the hours half of job margin.
    jobIdIdx: index('time_entries_job_id_idx').on(table.accountId, table.companyId, table.jobId),
    // Backs the unbilled picker: WHERE account, company, billed_invoice_id IS
    // NULL. Also serves the reverse lookup when an invoice is deleted.
    billedInvoiceIdIdx: index('time_entries_billed_invoice_id_idx').on(
      table.accountId,
      table.companyId,
      table.billedInvoiceId,
    ),
  }),
);

export type TimeEntry = typeof timeEntries.$inferSelect;
export type NewTimeEntry = typeof timeEntries.$inferInsert;
