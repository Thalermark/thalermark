import { z } from 'zod';
import { isoDateString, multiplyMoney, quantityString, sumMoney } from './money.js';

// Mileage trips (TMC-179) — the standard-mileage vehicle deduction.
//
// ─────────────────────────────────────────────────────────────────────────────
// RE-CHECK THIS TABLE EVERY JANUARY, AND WHENEVER THE IRS ISSUES A MID-YEAR
// NOTICE. Rates verified against irs.gov/tax-professionals/standard-mileage-rates
// on 2026-08-06. Same standing maintenance burden as the tax-worksheet line
// tables (TMC-168) — a stale rate here is a wrong number on a federal return,
// and it is the kind of wrong that looks perfectly reasonable.
// ─────────────────────────────────────────────────────────────────────────────
//
// KEYED BY EFFECTIVE DATE RANGE, NOT BY YEAR, and that is not defensive
// over-engineering: the IRS has split a year mid-way twice in recent memory.
// 2022 ran 58.5c through June and 62.5c from July, and 2026 does the same thing
// — 72.5c through June, 76c from July. A year → rate map returns a confidently
// wrong figure for every trip in the back half of the current year.
//
// So valuation is PER TRIP, against the rate in force on that trip's own date.
// Never totalMiles x aYearRate.
type MileageRate = {
  // Inclusive ISO date bounds. `through` is explicit rather than derived from
  // the next entry's start so the end of the table is a hard edge: a trip dated
  // after the last published rate finds nothing and is reported as unrated,
  // instead of silently inheriting a rate the IRS has not announced.
  from: string;
  through: string;
  // Dollars per mile as a 4dp price string, so mileageValue can hand it
  // straight to multiplyMoney with no parsing.
  rate: string;
};

// Business-use rates only. The charity / medical / moving rates are different
// numbers with different eligibility rules and are deliberately absent — this
// product deducts business miles.
export const STANDARD_MILEAGE_RATES: readonly MileageRate[] = [
  { from: '2022-01-01', through: '2022-06-30', rate: '0.5850' },
  { from: '2022-07-01', through: '2022-12-31', rate: '0.6250' },
  { from: '2023-01-01', through: '2023-12-31', rate: '0.6550' },
  { from: '2024-01-01', through: '2024-12-31', rate: '0.6700' },
  { from: '2025-01-01', through: '2025-12-31', rate: '0.7000' },
  { from: '2026-01-01', through: '2026-06-30', rate: '0.7250' },
  { from: '2026-07-01', through: '2026-12-31', rate: '0.7600' },
];

// The rate in force on a given date, or null when the IRS has not published one
// for it — a trip before the table starts, or in a year whose rate is not out
// yet (rates are typically announced in December for the year ahead).
//
// NULL IS THE POINT. Falling back to the previous year's rate would produce a
// number that is self-consistent, untestable against itself, and wrong on a
// filed return. Callers surface these miles separately as `unratedMiles` so the
// user can see exactly what is missing and why.
//
// ISO dates compare correctly as strings, so no Date object is constructed and
// no timezone can shift a trip across a rate boundary.
export function standardMileageRateFor(tripDate: string): string | null {
  const band = STANDARD_MILEAGE_RATES.find((r) => tripDate >= r.from && tripDate <= r.through);
  return band?.rate ?? null;
}

// What one trip's miles are worth, or null if its date has no published rate.
// multiplyMoney is the same BigInt-backed, half-away-from-zero helper every
// invoice line goes through, so a mileage dollar and an invoice dollar cannot
// round differently.
export function mileageValue(miles: string, tripDate: string): string | null {
  const rate = standardMileageRateFor(tripDate);
  return rate === null ? null : multiplyMoney(miles, rate);
}

export type MileageSummary = {
  tripCount: number;
  // 4dp, matching the column. Every trip, rated or not — this is "how far did I
  // drive for work", which the user asked and we can always answer.
  miles: string;
  // 2dp. The value of the RATED miles only, so the deduction never includes a
  // mile we could not price.
  amount: string;
  // 4dp. Miles whose date has no published rate, hence excluded from `amount`.
  // Non-zero means the UI owes the user an explanation.
  unratedMiles: string;
};

const MILES_SCALE = 4;

// Exact 4dp summation over miles. sumMoney works at the 2dp money scale and
// would truncate a tenth of a mile, so miles get their own integer accumulator
// rather than a lossy reuse.
function sumMiles(values: readonly string[]): string {
  let total = 0n;
  for (const v of values) {
    if (!/^\d+(\.\d+)?$/.test(v)) continue;
    const dot = v.indexOf('.');
    const intPart = dot === -1 ? v : v.slice(0, dot);
    const fracPart = dot === -1 ? '' : v.slice(dot + 1);
    total += BigInt(intPart + (fracPart + '0'.repeat(MILES_SCALE)).slice(0, MILES_SCALE));
  }
  const s = total.toString().padStart(MILES_SCALE + 1, '0');
  return `${s.slice(0, -MILES_SCALE)}.${s.slice(-MILES_SCALE)}`;
}

// Roll a set of trips into the figures every surface needs. Shared rather than
// per-client for the same reason hoursFromMinutes is: the API computes this for
// the tax worksheet and the clients compute it for the running total on the trip
// list, and the two must agree to the cent.
export function summariseMileage(
  trips: readonly { miles: string; tripDate: string }[],
): MileageSummary {
  const amounts: string[] = [];
  const unrated: string[] = [];
  for (const t of trips) {
    const value = mileageValue(t.miles, t.tripDate);
    if (value === null) unrated.push(t.miles);
    else amounts.push(value);
  }
  return {
    tripCount: trips.length,
    miles: sumMiles(trips.map((t) => t.miles)),
    amount: sumMoney(amounts),
    unratedMiles: sumMiles(unrated),
  };
}

// A single trip is capped well below anything a working day can produce. This is
// a typo guard, not a policy: 2000 miles in one day is not a landscaper's
// Tuesday, it is "245" typed into the wrong field. A genuine cross-country haul
// is several days and therefore several entries.
export const MAX_MILES_PER_TRIP = 2000;

const milesString = quantityString.refine(
  (s) => Number(s) > 0 && Number(s) <= MAX_MILES_PER_TRIP,
  `miles must be greater than 0 and no more than ${MAX_MILES_PER_TRIP}`,
);

export const mileageTripCreateSchema = z.object({
  companyId: z.string().uuid(),
  tripDate: isoDateString,
  miles: milesString,
  // Required, unlike a note elsewhere. §274(d) wants the business purpose, and
  // the deduction you cannot substantiate is the one that gets disallowed — so
  // this is the field the schema refuses to let the user skip.
  purpose: z.string().trim().min(1).max(500),
  // Which vehicle. Optional — a trip logged before any vehicle is set up is
  // still a real deduction, and the worksheet reports those miles as unassigned
  // rather than dropping them.
  vehicleId: z.string().uuid().nullable().optional(),
  // Optional: the drive to the bank belongs to no job.
  jobId: z.string().uuid().nullable().optional(),
});

export type MileageTripCreateInput = z.infer<typeof mileageTripCreateSchema>;

// companyId is absent: moving a trip between companies would move a deduction
// between two federal returns, which is a delete and a re-create, not an edit.
export const mileageTripUpdateSchema = z
  .object({
    tripDate: isoDateString.optional(),
    miles: milesString.optional(),
    purpose: z.string().trim().min(1).max(500).optional(),
    vehicleId: z.string().uuid().nullable().optional(),
    jobId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no_fields_to_update' });

export type MileageTripUpdateInput = z.infer<typeof mileageTripUpdateSchema>;

// ─── Vehicles, and Schedule C Part IV ────────────────────────────────────────
//
// Part IV "Information on Your Vehicle" is a per-vehicle disclosure: the
// instructions require a separate attached statement for each additional
// vehicle used during the year. These schemas carry the answers.
//
// Note what is NOT here: the standard-vs-actual election. It stays on the
// company — a per-vehicle method field would look authoritative and enforce
// nothing, because the binding rule is the irreversible year-one MACRS lock and
// we hold no year-one history. See the note at the foot of
// packages/db/src/schema/vehicles.ts.

// Schedule C line 45, "was your vehicle available for personal use during
// off-duty hours". Absent/null means NOT YET ASKED, which is distinct from
// 'none' and is what lets a purpose-built vehicle skip the year-end question
// entirely rather than being silently assumed into it.
export const VEHICLE_PERSONAL_USE = ['none', 'some'] as const;
export type VehiclePersonalUse = (typeof VEHICLE_PERSONAL_USE)[number];

export const VEHICLE_PERSONAL_USE_LABELS: Record<VehiclePersonalUse, string> = {
  none: 'Only for work',
  some: 'Work and personal',
};

export const vehicleCreateSchema = z.object({
  companyId: z.string().uuid(),
  label: z.string().trim().min(1).max(100),
  // Line 43. Optional — someone adding a vehicle mid-conversation shouldn't be
  // blocked on a date they have to go and look up.
  placedInServiceOn: isoDateString.nullable().optional(),
  personalUse: z.enum(VEHICLE_PERSONAL_USE).nullable().optional(),
  // Line 46 — a taxpayer-level fact about a vehicle we never see. Do not derive
  // it from personalUse: for a work-only vehicle the honest pair is 45 = No,
  // 46 = Yes, and that combination is the strongest case for the deduction.
  anotherVehicleAvailable: z.boolean().nullable().optional(),
});

export type VehicleCreateInput = z.infer<typeof vehicleCreateSchema>;

// companyId is absent: moving a vehicle between companies would move a
// disclosure between two federal returns.
export const vehicleUpdateSchema = z
  .object({
    label: z.string().trim().min(1).max(100).optional(),
    placedInServiceOn: isoDateString.nullable().optional(),
    personalUse: z.enum(VEHICLE_PERSONAL_USE).nullable().optional(),
    anotherVehicleAvailable: z.boolean().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no_fields_to_update' });

export type VehicleUpdateInput = z.infer<typeof vehicleUpdateSchema>;
