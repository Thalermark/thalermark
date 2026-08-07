import { bigint, index, numeric, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { companies } from './companies.js';
import { vehicles } from './vehicles.js';

// The per-year half of Schedule C Part IV — line 44, "of the total number of
// miles you drove your vehicle during <year>, enter the number of miles you used
// your vehicle for: a Business  b Commuting  c Other".
//
// SPLIT FROM `vehicles` BY WHEN THE USER CAN ANSWER, not by tidiness. The date a
// truck was placed in service and whether it is ever driven personally are
// standing facts, knowable any day, so they live on the vehicle. How far it went
// in total is only knowable once the year is over. Asking in March for the
// current year's total is nonsense, and storing it on the vehicle would mean one
// year's answer silently overwriting another's.
//
// Only ONE figure is actually asked for. Business miles come from the trip log,
// and `other_miles` is NEVER STORED — it is total − business − commuting. Store
// all three and you own a reconciliation problem forever; store two and the
// arithmetic is closed and cannot contradict itself.
//
// NOT PERIOD-LOCKED, unlike mileage_trips, and the divergence is deliberate. A
// trip changes the dollar figure on line 9. Nothing here changes a dollar figure
// on any form — these fill a disclosure box. A corporation that closes 2026 in
// January must still be able to answer in March when the return is prepared.
export const vehicleYears = pgTable(
  'vehicle_years',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    // CASCADE, unlike mileage_trips.vehicle_id which SET NULLs. A trip is
    // substantiation and has meaning on its own — "24.5 miles to the Miller
    // place" is still evidence with no vehicle attached. A year row is nothing
    // but a fact ABOUT a vehicle; orphaned it says "something did 12,000 miles".
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id, { onDelete: 'cascade' }),
    // bigint rather than integer to satisfy squawk's prefer-bigint-over-int,
    // the same call period_closes.fiscal_year made.
    taxYear: bigint('tax_year', { mode: 'number' }).notNull(),
    // Every mile the vehicle did that year, for any purpose — the denominator of
    // line 44. NULLABLE because it is the one thing we have to ask for, and an
    // unanswered year has to be distinguishable from a zero-mile one.
    //
    // An ESTIMATE, deliberately. Odometer readings would need a number taken on
    // 1 January of a year that is already over; nobody has it, so they would
    // estimate anyway and we would store two invented numbers instead of one.
    // And this figure is not multiplied by anything — line 44 is a disclosure,
    // so a total wrong by 500 miles changes the deduction by exactly zero cents.
    // Same scale as mileage_trips.miles so the comparison against logged
    // business miles is exact.
    totalMiles: numeric('total_miles', { precision: 15, scale: 4 }),
    // Line 44b. Commuting — home to a regular workplace — is NOT deductible, and
    // is the reason this can't simply be folded into "personal".
    //
    // Defaults to 0 rather than NULL because for this audience it genuinely is:
    // when home is the principal place of business, the drive to the first job
    // site is business mileage, not commuting. Defaulted, not asserted — the
    // form still shows the box and the user can correct it.
    commutingMiles: numeric('commuting_miles', { precision: 15, scale: 4 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('vehicle_years_account_id_idx').on(table.accountId),
    // One row per vehicle per year — the worksheet reads exactly one year, and a
    // second row for the same pair would make "what did this truck do in 2026"
    // ambiguous on a federal disclosure.
    vehicleYearUq: uniqueIndex('vehicle_years_vehicle_year_uq').on(table.vehicleId, table.taxYear),
  }),
);

export type VehicleYear = typeof vehicleYears.$inferSelect;
export type NewVehicleYear = typeof vehicleYears.$inferInsert;
