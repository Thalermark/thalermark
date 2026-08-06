import { z } from 'zod';
import { isoDateString, priceString } from './money.js';

// Time entries (TMC-180) — hours worked on a job.
//
// minutes crosses the wire as a JSON number, not a decimal string. The
// decimal-string rule exists for money and quantity, where IEEE-754 rounding
// would corrupt a total; an integer count of minutes has no fractional part to
// lose. Hours are DERIVED at billing time (hoursFromMinutes below) and never
// stored, so there is exactly one rounding step in the whole path.
//
// Capped at one full day. An entry carries a single entryDate, so more than
// 24 hours against it is a typo — almost always "600" meant as 6:00. A genuine
// shift across midnight is two entries, which is also how it should read on the
// invoice.
export const MINUTES_IN_A_DAY = 1440;

export const timeEntryCreateSchema = z.object({
  jobId: z.string().uuid(),
  entryDate: isoDateString,
  minutes: z.number().int().positive().max(MINUTES_IN_A_DAY),
  note: z.string().trim().max(1000).optional(),
  // Nullable: time logged purely for margin, with nothing to bill, is a real and
  // common case — and the owner's own hours are never billable to anyone.
  rate: priceString.nullable().optional(),
  sourceItemId: z.string().uuid().nullable().optional(),
  membershipId: z.string().uuid().nullable().optional(),
});

export type TimeEntryCreateInput = z.infer<typeof timeEntryCreateSchema>;

// Partial, like jobUpdateSchema. jobId is absent: moving an entry between jobs
// would silently restate two jobs' margins at once, so it is a delete and a
// re-create rather than an edit.
//
// billedInvoiceId is absent too — an entry becomes billed only by riding along
// on an invoice create/update (see billedTimeEntryIds on the invoice schemas),
// never by a client asserting it directly. That keeps "is this billed" a fact
// the server derives from an invoice that actually exists.
export const timeEntryUpdateSchema = z
  .object({
    entryDate: isoDateString.optional(),
    minutes: z.number().int().positive().max(MINUTES_IN_A_DAY).optional(),
    note: z.string().trim().max(1000).nullable().optional(),
    rate: priceString.nullable().optional(),
    sourceItemId: z.string().uuid().nullable().optional(),
    membershipId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no_fields_to_update' });

export type TimeEntryUpdateInput = z.infer<typeof timeEntryUpdateSchema>;

// Minutes → hours as a 4dp quantity string, matching invoice_line_items.quantity
// (numeric(15,4)) so tracked time drops onto a line the same shape a hand-typed
// one has. Half-away-from-zero, like every other rounding step in money.ts.
//
// Integer math throughout: minutes is a positive integer bounded by 1440, so
// minutes * 10_000 stays far inside the safe-integer range and never touches a
// float. 195 minutes → "3.2500"; 50 → "0.8333".
//
// The line AMOUNT is then multiplyMoney(hours, rate) — the same helper every
// other line uses, so a billed hour and a hand-typed hour cannot round
// differently.
export function hoursFromMinutes(minutes: number): string {
  const tenThousandths = Math.round((minutes * 10_000) / 60);
  const whole = Math.floor(tenThousandths / 10_000);
  const frac = String(tenThousandths % 10_000).padStart(4, '0');
  return `${whole}.${frac}`;
}
