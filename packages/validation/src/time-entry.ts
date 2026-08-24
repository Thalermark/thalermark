import { z } from 'zod';
import {
  formatDateShort,
  formatQuantity,
  isoDateString,
  priceString,
  quantityString,
} from './money.js';

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

const CAP_MESSAGE = 'That is more than a day. Enter hours like 3.25, or 0:30 for half an hour.';

// How a job bills (TMC-264). Asked ONCE on the job, inherited by every entry.
//
// A CLOSED SET because the invoice line has to read "3 visits" and not
// "3 visitss". items.unit_label is free text and its comment says exactly why
// pluralising arbitrary input at display time turns "box" into "boxs" — here the
// label is ours and the quantity is known, so the plural is safe. A per-yard
// business corrects the seeded line's unitLabel on the invoice, which is already
// editable on both clients; widening this list is a data change, not a schema
// one, whenever someone actually asks.
export const BILLING_UNITS = ['hour', 'visit', 'day', 'night', 'job'] as const;
export type BillingUnit = (typeof BILLING_UNITS)[number];

const UNIT_WORDS: Record<BillingUnit, readonly [string, string]> = {
  hour: ['hour', 'hours'],
  visit: ['visit', 'visits'],
  day: ['day', 'days'],
  night: ['night', 'nights'],
  job: ['job', 'jobs'],
};

export function isBillingUnit(v: string): v is BillingUnit {
  return (BILLING_UNITS as readonly string[]).includes(v);
}

// Compared through formatQuantity so "1.0000" and "1" agree without coercing a
// decimal string to a float. Unknown units fall back to hour, which is the
// column default and therefore what a row written before TMC-264 means.
export function billingUnitLabel(unit: string, quantity: string): string {
  const words = UNIT_WORDS[isBillingUnit(unit) ? unit : 'hour'];
  return formatQuantity(quantity) === '1' ? words[0] : words[1];
}

// A wall-clock time as the business keeps it, "HH:MM" or "HH:MM:SS" (an
// <input type="time"> emits either). Returns minutes past midnight, or null when
// it cannot be read — which the caller turns into a field error rather than a
// guess, same contract as minutesFromDuration.
function minutesPastMidnight(raw: string): number | null {
  const m = /^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?$/.exec(raw.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  if (hours > 23) return null;
  return hours * 60 + Number(m[2]);
}

export type ClockSpan = { minutes: number; crossesMidnight: boolean };

// The time card (TMC-265): "8:15 to 4:30" without making anyone work out that it
// is 8.25 hours. An INPUT METHOD, not a new kind of record — the output is an
// ordinary entry, exactly as the stopwatch fills the duration field rather than
// logging directly.
//
// AN OVERNIGHT SPAN IS ONE ENTRY, NOT TWO (owner decision, 2026-08-22). An
// earlier reading of this had it splitting at midnight into two dated entries.
// The owner's call: someone reaching for a time card wants to know how many
// hours they worked, and does not care that the clock passed midnight on the
// way. So end-before-start means the next day, the span is computed across the
// boundary, and ONE entry is written dated by its START.
//
// This needs no exception to the MINUTES_IN_A_DAY cap, contrary to how TMC-265
// framed it. That cap rejects an entry LONGER than 24 hours; it says nothing
// about crossing midnight. 10pm to 6am is 480 minutes and always was legal.
//
// `crossesMidnight` is returned rather than hidden so the caller can SAY so.
// Detect and confirm: the clients show the computed duration and note the
// overnight run before anything is submitted, which is the confirmation. No
// modal, no second question.
export function minutesFromClockSpan(start: string, end: string): ClockSpan | null {
  const s = minutesPastMidnight(start);
  const e = minutesPastMidnight(end);
  if (s === null || e === null) return null;
  // Equal times are a zero-length shift, which is a typo rather than a fact.
  if (s === e) return null;
  const crossesMidnight = e < s;
  return {
    minutes: crossesMidnight ? MINUTES_IN_A_DAY - s + e : e - s,
    crossesMidnight,
  };
}

// The quantity that goes on the invoice line for one tracked entry.
//
// THE WHOLE POINT OF TMC-264. On an hourly job this is the old behaviour
// untouched: derived from minutes, one rounding step, at 4dp. On any other unit
// it is the recorded COUNT — because deriving it from minutes would invoice
// three 30-minute visits as "1.5 visits", which is wrong in a way the customer
// can see.
//
// Null when the entry has nothing to bill in its job's unit (an hourly entry
// with no duration, or a per-visit entry with no count). Callers skip those
// rather than seeding a zero line.
export function timeEntryQuantity(
  entry: { minutes?: number | null; quantity?: string | null; unit?: string | null },
  jobBillingUnit: string,
): string | null {
  const unit = entryUnit(entry, jobBillingUnit);
  if (unit === 'hour') {
    return entry.minutes == null ? null : hoursFromMinutes(entry.minutes);
  }
  return entry.quantity ?? null;
}

// WHICH UNIT THIS LINE BILLS IN.
//
// The unit began as a property of the JOB, asked once and inherited. That holds
// for a lawn crew and breaks for the audience the feature was built for: a dog
// sitter charges a flat rate for a drop-in visit AND an hourly rate when she
// stays the afternoon, on one job for one customer. So it became a property of
// the ENTRY, with the job's unit demoted to a default.
//
// A null entry unit means "whatever this job bills in", which is exactly what
// every row written before that change meant. An unrecognised value on either
// falls back to hours, matching the column default.
//
// One function, called by the API and by both clients, because a line seeded on
// a phone and the same line seeded on a desktop must not bill differently.
export function entryUnit(entry: { unit?: string | null }, jobBillingUnit: string): BillingUnit {
  if (entry.unit && isBillingUnit(entry.unit)) return entry.unit;
  return isBillingUnit(jobBillingUnit) ? jobBillingUnit : 'hour';
}

// "HH:MM" or "HH:MM:SS", the two shapes an <input type="time"> emits. A bare
// wall-clock time with no zone, matching the `time` column it lands in.
export const clockTimeString = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Use a time like 08:15.');

// At least one of minutes or quantity has to be there, or the entry records
// nothing. Stated here rather than as a CHECK constraint, following items.type
// and companies.business_type — see migration 0043.
//
// Which one is REQUIRED depends on the job's billing unit, which this schema
// cannot see (the job is a foreign key, resolved server-side). The route
// enforces the unit-specific half; this catches the case that is wrong under
// every unit.
const hasSomethingRecorded = (v: { minutes?: number | null; quantity?: string | null }) =>
  v.minutes != null || v.quantity != null;

const RECORD_SOMETHING = {
  message: 'Enter how long it took, or how many.',
};

// The fields shared by both create shapes. Split out because the two refinements
// below turn a ZodObject into a ZodEffects, which has no .omit() — and the
// job-scoped route needs exactly that (the job comes from the path, not the
// body). Building two objects from one shape keeps them honestly identical
// instead of relying on a strip that stopped being available.
const timeEntryFields = {
  entryDate: isoDateString,
  // Nullable since TMC-264: optional on a job that does not bill by the hour.
  // The cap's message is written for a HUMAN TYPING HOURS, because that is what
  // every entry form asks for. Zod's default said "Enter 1440 or less", quoting
  // a minute count the user never typed and cannot relate to the box in front of
  // them. Someone entering "30" for half an hour hit it and learned nothing
  // (owner report, 2026-08-23).
  minutes: z.number().int().positive().max(MINUTES_IN_A_DAY, CAP_MESSAGE).nullable().optional(),
  // The count in this line's unit. Null when the line bills by the hour, where
  // the count IS the duration.
  quantity: quantityString.nullable().optional(),
  // This line's own unit. Omitted or null inherits the job's.
  unit: z.enum(BILLING_UNITS).nullable().optional(),
  // What a time card was typed as (TMC-265). Both or neither; a start with no
  // end is a half-finished thought, not a record. Kept alongside the computed
  // minutes because when the work happened matters on the invoice (TMC-263).
  startTime: clockTimeString.nullable().optional(),
  endTime: clockTimeString.nullable().optional(),
  note: z.string().trim().max(1000).optional(),
  // Nullable: time logged purely for margin, with nothing to bill, is a real and
  // common case — and the owner's own hours are never billable to anyone.
  rate: priceString.nullable().optional(),
  sourceItemId: z.string().uuid().nullable().optional(),
  membershipId: z.string().uuid().nullable().optional(),
};

const BOTH_CLOCK_TIMES = { message: 'Enter both a start and an end time, or neither.' };

const bothOrNeitherClockTime = (v: { startTime?: string | null; endTime?: string | null }) =>
  (v.startTime == null) === (v.endTime == null);

// The two refinements are applied to each schema rather than through a generic
// helper. A `<T extends ZodRawShape>` wrapper compiles but erases the field
// types inside the predicates, so `v.startTime` stops existing — two repeated
// lines are the cheaper trade, and the repo prefers them to an abstraction that
// costs type safety.

// Body for the job-scoped create route: the job comes from the path.
export const timeEntryCreateOnJobSchema = z
  .object(timeEntryFields)
  .refine(hasSomethingRecorded, RECORD_SOMETHING)
  .refine(bothOrNeitherClockTime, BOTH_CLOCK_TIMES);

export const timeEntryCreateSchema = z
  .object({ jobId: z.string().uuid(), ...timeEntryFields })
  .refine(hasSomethingRecorded, RECORD_SOMETHING)
  .refine(bothOrNeitherClockTime, BOTH_CLOCK_TIMES);

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
    minutes: z.number().int().positive().max(MINUTES_IN_A_DAY, CAP_MESSAGE).nullable().optional(),
    quantity: quantityString.nullable().optional(),
    unit: z.enum(BILLING_UNITS).nullable().optional(),
    startTime: clockTimeString.nullable().optional(),
    endTime: clockTimeString.nullable().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
    rate: priceString.nullable().optional(),
    sourceItemId: z.string().uuid().nullable().optional(),
    membershipId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Change at least one thing before saving.',
  })
  // Only when the caller touches them. A partial update that mentions neither
  // must not be judged against fields it never sent — the row on disk already
  // satisfies this, and the route re-checks the merged result.
  .refine((v) => !('minutes' in v && 'quantity' in v) || hasSomethingRecorded(v), RECORD_SOMETHING)
  .refine(
    (v) =>
      !('startTime' in v || 'endTime' in v) ||
      ((v.startTime ?? null) === null) === ((v.endTime ?? null) === null),
    { message: 'Enter both a start and an end time, or neither.' },
  );

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
// The inverse, for entry: read what a person types into the integer minutes the
// API stores. Nobody thinks in minutes, and the two ways people write three and
// a quarter hours are "3.25" and "3:15" — so accept both rather than teaching a
// format. Returns null when it cannot be read, which the caller turns into a
// field error instead of guessing.
//
// Shared rather than per-client: web and mobile must agree, or the same typed
// string becomes two different durations.
export function minutesFromDuration(raw: string): number | null {
  const s = raw.trim();
  if (s === '') return null;
  const colon = /^(\d+):([0-5]\d)$/.exec(s);
  if (colon) {
    const minutes = Number(colon[1]) * 60 + Number(colon[2]);
    return minutes > 0 ? minutes : null;
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const minutes = Math.round(Number(s) * 60);
  return minutes > 0 ? minutes : null;
}

export function hoursFromMinutes(minutes: number): string {
  const tenThousandths = Math.round((minutes * 10_000) / 60);
  const whole = Math.floor(tenThousandths / 10_000);
  const frac = String(tenThousandths % 10_000).padStart(4, '0');
  return `${whole}.${frac}`;
}

// The invoice line label for a billed time entry. Both invoice forms on web and
// both on mobile seed rows from tracked hours, and this mapping lived four times
// with THREE different fallbacks — web's new-invoice form named the job, the
// other three said a bare "Hours" — so the same job billed from a phone read
// differently than the same job billed from a desktop.
//
// The date leads the label because without it several days of the same work
// render as identical lines. A dog sitter billing three days produced three rows
// reading "Dog sitting", which a customer reads as one charge listed three times
// rather than three days of work (TMC-263).
//
// The job name is the fallback rather than the word "Hours": the unit column
// already says hour, and the date already says which day, so the description is
// the only place left to name the work.
// A stored "HH:MM[:SS]" as a customer would read it: "7:00am", "3:00pm".
// 12-hour because this lands on an invoice a member of the public reads, not on
// an operator screen.
export function formatClockTime(raw: string): string {
  const m = /^([01]\d|2[0-3]):([0-5]\d)/.exec(raw.trim());
  if (!m) return raw;
  const h24 = Number(m[1]);
  const suffix = h24 < 12 ? 'am' : 'pm';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${m[2]}${suffix}`;
}

export function timeEntryLineDescription(entry: {
  entryDate: string;
  note?: string | null;
  jobName?: string | null;
  startTime?: string | null;
  endTime?: string | null;
}): string {
  const body = entry.note?.trim() || entry.jobName?.trim() || 'Hours';
  // A time-card entry says WHEN, because it knows (TMC-265). "Aug 12, 7:00am to
  // 3:00pm · Dog sitting" answers a client questioning the bill in a way
  // "Aug 12 · Dog sitting" at 8 hours cannot. Typed and stopwatch entries have
  // no clock times and are unchanged.
  const when =
    entry.startTime && entry.endTime
      ? `${formatDateShort(entry.entryDate)}, ${formatClockTime(entry.startTime)} to ${formatClockTime(entry.endTime)}`
      : formatDateShort(entry.entryDate);
  return `${when} · ${body}`;
}

// "1 hour" but "3 hours", and "0.8333 hours". Decided at seed time rather than
// at render because unitLabel is a free-text field the user can overwrite with
// anything — pluralising arbitrary input at display time turns "box" into "boxs"
// and "inch" into "inchs". Here the label is ours and the quantity is known.
//
// Compared through formatQuantity so "1.0000" and "1" agree without coercing a
// decimal string to a float.
export function hoursUnitLabel(quantity: string): string {
  return billingUnitLabel('hour', quantity);
}
