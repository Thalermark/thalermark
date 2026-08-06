import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { companies } from './companies.js';

// Vehicles (TMC-179 follow-up) — the per-vehicle identity Schedule C Part IV
// "Information on Your Vehicle" requires.
//
// WHY A TABLE RATHER THAN A LABEL ON THE TRIP. Part IV demands per-vehicle
// DISCLOSURE, and the instructions are explicit — "if you used more than one
// vehicle during the year, attach a statement with the information requested in
// Schedule C, Part IV, for each additional vehicle." A free-text label can name
// a vehicle but cannot carry the date it was placed in service or the two
// personal-use answers, and it cannot stop the same truck being spelled two ways
// and disclosed twice.
//
// REPORTING is what earns it, not enforcement — and the distinction matters,
// because the obvious next step is wrong. See "DO NOT MOVE
// vehicle_expense_method HERE" at the foot of this file.
//
// COMPANY-SCOPED, not account-scoped. One physical truck used by two businesses
// that file two Schedule Cs is two disclosures — each return reports its own use
// of it, with the same total miles and different business miles. That is correct
// per the form, and company scoping gets it for free.
//
// Nothing here posts to the ledger, and nothing here changes a dollar figure on
// any form. These fill a disclosure box. That is also why vehicle data is NOT
// period-locked while mileage trips are (see routes/mileage.ts).
export const vehicles = pgTable(
  'vehicles',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    // What the user calls it — "F-150", "the plow truck". Free text, because
    // Part IV asks which vehicle, not what make and model it is.
    label: text('label').notNull(),
    // Schedule C line 43, "when did you place your vehicle in service for
    // business purposes". NULLABLE: a vehicle backfilled from an old trip's
    // free-text label has no answer, and inventing one puts a fabricated date on
    // a federal disclosure.
    placedInServiceOn: date('placed_in_service_on', { mode: 'string' }),
    // Schedule C line 45, "was your vehicle available for personal use during
    // off-duty hours". App-layer enum 'none' | 'some'.
    //
    // THREE-STATE, AND THE NULL IS LOAD-BEARING. NULL means not yet asked. With
    // NOT NULL DEFAULT 'none' you cannot tell "they said no" from "we guessed
    // no" — and the guess is an affirmative false statement on a signed return.
    // It is also what sizes the year-end ask: a vehicle marked 'none' has total
    // miles equal to the business miles already logged, so there is nothing left
    // to ask. That is the whole reason a purpose-built plow truck costs its
    // owner no year-end work at all.
    personalUse: text('personal_use'),
    // Schedule C line 46, "do you (or your spouse) have ANOTHER vehicle
    // available for personal use".
    //
    // This is a taxpayer-level fact about a vehicle we will never see, not a
    // property of this row — it carries the same answer on every vehicle. Stored
    // here anyway so it is asked in the one place gated on expenses:write,
    // rather than becoming a companies column behind settings:manage where an
    // accountant could not answer it. Redundant across rows; accepted.
    //
    // Do not fold it into personalUse. For a purpose-built work vehicle the
    // honest pair is 45 = No, 46 = Yes, and that combination is the STRONGEST
    // case for the deduction — it answers the obvious question of what the owner
    // drives on a Saturday. Deriving 46 from 45 would print "No, No", which is
    // the answer that invites the audit.
    anotherVehicleAvailable: boolean('another_vehicle_available'),
    // Sold, scrapped, or otherwise out of the business. Retired rather than
    // deleted, mirroring tax_policies.archived_at — a vehicle disposed of in
    // June still has to appear on that year's return.
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('vehicles_account_id_idx').on(table.accountId),
    companyIdx: index('vehicles_company_idx').on(table.accountId, table.companyId),
    // CORRECTNESS, not tidiness. Two rows for one truck splits its business
    // miles across two Part IV disclosures, and each one understates. Partial so
    // a retired vehicle's label can be reused, and case/whitespace-insensitive
    // because "F-150" and "f-150 " are never two vehicles.
    companyLabelActiveUq: uniqueIndex('vehicles_company_label_active_uq')
      .on(table.companyId, sql`lower(btrim(${table.label}))`)
      .where(sql`${table.retiredAt} is null`),
  }),
);

export type Vehicle = typeof vehicles.$inferSelect;
export type NewVehicle = typeof vehicles.$inferInsert;

// DO NOT MOVE vehicle_expense_method HERE.
//
// It lives on `companies`, and the fact that this table exists is not a reason
// to move it. The IRS rule genuinely is per-vehicle, which is exactly what makes
// the mistake tempting — but the constraint that actually binds is the
// irreversible one: claim actual expenses with MACRS in a vehicle's first year
// and that vehicle can never move to the standard rate again. We hold no
// year-one history to enforce that against, so a per-vehicle column here would
// look authoritative and enforce nothing, while giving a user a switch that
// silently produces an invalid return.
//
// Part IV changes none of that. It asks who the vehicle is, not how it is
// deducted.
