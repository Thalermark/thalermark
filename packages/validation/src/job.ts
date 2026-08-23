import { z } from 'zod';
import { isoDateString } from './money.js';
import { BILLING_UNITS } from './time-entry.js';

// Jobs (TMC-181) — the named unit of work that exists before any invoice does.
//
// 'closed' is a filing action, not a state machine: it drops the job out of the
// pickers and nothing else. There is no "invoiced" or "complete" status, because
// a job's relationship to its invoices is many-valued (a deposit plus a final,
// an ongoing arrangement billed biweekly) and no single status could describe
// it honestly.
export const JOB_STATUSES = ['open', 'closed'] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

// endedOn before startedOn is always a typo, and catching it here turns a
// nonsense date range into a 400 instead of a job that silently sorts wrong.
// Both absent or either alone is fine — most jobs never get dates at all.
function datesInOrder(v: { startedOn?: string | null; endedOn?: string | null }): boolean {
  if (!v.startedOn || !v.endedOn) return true;
  return v.startedOn <= v.endedOn;
}

const DATE_ORDER_ERROR = { message: 'The end date is before the start date.' } as const;

export const jobCreateSchema = z
  .object({
    companyId: z.string().uuid(),
    // What the user calls it. Free text and never derived from the contact —
    // "the Smith job" and "Tuesdays at the Chens" are both valid and only he
    // knows which he means.
    name: z.string().trim().min(1).max(200),
    contactId: z.string().uuid().nullable().optional(),
    // How this job bills, asked once here rather than on every entry (TMC-264).
    // Optional and defaulting to 'hour' in the column, so a client that never
    // sends it gets exactly the pre-TMC-264 behaviour.
    billingUnit: z.enum(BILLING_UNITS).optional(),
    startedOn: isoDateString.optional(),
    endedOn: isoDateString.optional(),
  })
  .refine(datesInOrder, DATE_ORDER_ERROR);

export type JobCreateInput = z.infer<typeof jobCreateSchema>;

// PATCH is partial — the job detail screen edits one field at a time (rename,
// close, set an end date) rather than submitting the whole record. companyId is
// absent for the same reason it is on invoices: a job cannot move between
// companies, and its time entries and cost tags are company-scoped alongside it.
export const jobUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    contactId: z.string().uuid().nullable().optional(),
    status: z.enum(JOB_STATUSES).optional(),
    // Changeable after the fact. It re-reads how EXISTING entries bill, which is
    // the point: someone who logged three visits as hours by mistake fixes the
    // job rather than re-entering the work. The entries themselves are untouched
    // — each keeps both its minutes and its count, and the unit decides which
    // one reaches the invoice.
    billingUnit: z.enum(BILLING_UNITS).optional(),
    startedOn: isoDateString.nullable().optional(),
    endedOn: isoDateString.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Change at least one thing before saving.' })
  .refine(datesInOrder, DATE_ORDER_ERROR);

export type JobUpdateInput = z.infer<typeof jobUpdateSchema>;
