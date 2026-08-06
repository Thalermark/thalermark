import { date, index, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { companies } from './companies.js';
import { jobs } from './jobs.js';
import { vehicles } from './vehicles.js';

// Business trips, for the vehicle deduction (TMC-179). Date, miles, purpose —
// the contemporaneous record IRC §274(d) asks for, and the thing a landscaper
// otherwise reconstructs from memory in April. At the current IRS rate 8,000
// business miles is a ~$5,900 deduction, routinely the largest single number on
// the return, and today the tax worksheet flags Schedule C line 9 "you must
// supply this" precisely because we don't track it.
//
// THIS TABLE POSTS NOTHING TO THE LEDGER, FOR ANY ENTITY TYPE, EVER. No money
// moves when you drive. Standard mileage is a statutory substitute for actual
// costs — a tax figure, not a bookkeeping one — so a journal entry here would
// invent cash that never left the bank and break reconciliation. Log five
// hundred trips and the balance sheet, the P&L and the job-margin report are
// byte-identical; there is an integration test that asserts exactly that, and it
// is the load-bearing test of the whole feature. A design that starts wanting
// journal entries to make mileage work is the wrong design.
//
// What varies by entity type is only what the number is USED for, and none of it
// happens here:
//   sole prop / single-member LLC — a deduction, added to Schedule C line 9 at
//     read time as a computed addend beside the mapped 6100 total.
//   S-corp / C-corp — a REIMBURSEMENT the business owes the driver under an
//     accountable plan (a shareholder-employee cannot deduct it personally).
//     That reimbursement is ordinary spend and posts on its own, as a bill or an
//     expense to 6100, through paths that already exist.
//   partnership — reimbursed the same way, or the partner's UPE on their own
//     Schedule E, which touches the partnership's books nowhere.
// In all four cases the trip log itself is inert. It is a record, not a route.
export const mileageTrips = pgTable(
  'mileage_trips',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    // A bare calendar date, like time_entries.entry_date. It is also the RATE
    // KEY: the IRS has split a year mid-way twice in recent memory (2022, and
    // 2026 — 72.5c through June, 76c from July), so every trip is valued against
    // the rate in force on its own date. Never total-miles x a year rate.
    tripDate: date('trip_date', { mode: 'string' }).notNull(),
    // numeric(15,4), the same scale as invoice_line_items.quantity, so valuation
    // is multiplyMoney(miles, rate) in @thalermark/validation — the identical
    // BigInt-backed, half-away-from-zero rounding every invoice line goes
    // through. No new arithmetic and no float anywhere near a tax figure.
    miles: numeric('miles', { precision: 15, scale: 4 }).notNull(),
    // Required, unlike a note elsewhere. §274(d) wants the business purpose, and
    // "the deduction you cannot substantiate" is the one that gets disallowed —
    // so this is the one field the schema refuses to let the user skip.
    purpose: text('purpose').notNull(),
    // Which vehicle (Schedule C Part IV, line 44a). The reason `vehicles`
    // exists: Part IV is a per-vehicle disclosure, and the instructions require
    // a separate attached statement for each additional vehicle used.
    //
    // NULLABLE. A trip logged before the driver has set a vehicle up is still a
    // real deduction, and forcing NOT NULL would mean inventing an "Unspecified
    // vehicle" row that then appears on the return carrying a fabricated
    // placed-in-service date. A null here is also a SIGNAL the worksheet needs:
    // those miles fed line 9 but belong to no Part IV row, so the worksheet
    // reports them as unassigned rather than letting the disclosure quietly
    // understate what was claimed.
    //
    // SET NULL for the same reason job_id uses it — deleting a vehicle must not
    // destroy the evidence for a deduction already claimed.
    vehicleId: uuid('vehicle_id').references(() => vehicles.id, { onDelete: 'set null' }),
    // Optional job attribution — "drove to the Miller place".
    //
    // NULLABLE, and this is the deliberate divergence from time_entries.job_id,
    // which is NOT NULL. Tracked time only exists because someone worked a job;
    // a drive to the bank, the supply house or the accountant is an ordinary
    // deductible business mile belonging to no job at all. Forcing a job here
    // would either lose those trips or invent a fake job to hold them.
    //
    // SET NULL, not cascade: this is tax substantiation. Deleting a job must not
    // destroy the evidence for a deduction already claimed. Note this is context
    // and a list filter only — mileage is NOT a job-margin input, because margin
    // buckets reconcile against the P&L and mileage is not in the P&L.
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('mileage_trips_account_id_idx').on(table.accountId),
    // Backs both readers: the trip list (newest first) and the tax-year window
    // the worksheet sums over.
    tripDateIdx: index('mileage_trips_trip_date_idx').on(
      table.accountId,
      table.companyId,
      table.tripDate,
    ),
    jobIdIdx: index('mileage_trips_job_id_idx').on(table.accountId, table.companyId, table.jobId),
    // Backs the per-vehicle business-miles rollup the Part IV disclosure needs.
    vehicleIdIdx: index('mileage_trips_vehicle_id_idx').on(
      table.accountId,
      table.companyId,
      table.vehicleId,
    ),
  }),
);

export type MileageTrip = typeof mileageTrips.$inferSelect;
export type NewMileageTrip = typeof mileageTrips.$inferInsert;
