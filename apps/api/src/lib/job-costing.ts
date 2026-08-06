import {
  type Transaction,
  expenseAllocations,
  expenses,
  invoices,
  jobs,
  timeEntries,
} from '@thalermark/db';
import { centsToMoney } from '@thalermark/validation';
import { and, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';

// Shared job-costing math (TMC-181). routes/jobs.ts, routes/invoices.ts and the
// job-margin report all need "what did this job cost", "what did it bill" and
// "how many hours went in". Three copies would drift the first time one was
// edited — which is exactly how the voided-invoice bug got in.
//
// Nothing here reads or writes the ledger. Job margin is a lens over invoices,
// expense tags and tracked time; delete every one of these tables and the books
// are unchanged.

// Which invoice statuses count as billed. A positive allowlist, not a list of
// exclusions: the previous form excluded the literal 'void' while the stored
// value is 'voided', so voided invoices silently counted as revenue. An
// allowlist can also never be widened by accident when a status is added.
export const BILLED_INVOICE_STATUSES = ['sent', 'paid'] as const;

// One expense-allocation row's contribution, in cents. Kept in one place so the
// per-invoice block on GET /api/invoices/:id and the per-job rollup round
// identically — share is a fraction, so the rounding step is real.
function allocationCents(amount: string, share: string): number {
  return Math.round(Number(amount) * 100 * Number(share));
}

function scope(accountId: string, companyId: string, deletedGuard = true) {
  return [
    eq(expenseAllocations.accountId, accountId),
    eq(expenseAllocations.companyId, companyId),
    ...(deletedGuard ? [isNull(expenses.deletedAt)] : []),
  ];
}

// Cost attributed to each job, in cents.
//
// Costs reach a job two ways and BOTH count:
//   - tagged straight to the job (expense_allocations.job_id)
//   - tagged to one of the job's invoices (expense_allocations.invoice_id,
//     where that invoice belongs to the job)
// The second path is what keeps a job honest for costs tagged before the job
// existed, and for the invoice-grain tagging the expense screens still do.
//
// Invoice status is deliberately NOT filtered here, unlike billed below. Voiding
// an invoice cancels the revenue, not the money already spent. A job whose
// invoice was voided showing a loss is the correct answer, not a glitch.
export async function jobCostCents(
  tx: Transaction,
  accountId: string,
  companyId: string,
  jobIds?: string[],
): Promise<Map<string, number>> {
  const byJob = new Map<string, number>();
  if (jobIds && jobIds.length === 0) return byJob;

  const add = (jobId: string | null, amount: string, share: string) => {
    if (!jobId) return;
    byJob.set(jobId, (byJob.get(jobId) ?? 0) + allocationCents(amount, share));
  };

  const direct = await tx
    .select({
      jobId: expenseAllocations.jobId,
      amount: expenses.amount,
      share: expenseAllocations.share,
    })
    .from(expenseAllocations)
    .innerJoin(expenses, eq(expenses.id, expenseAllocations.expenseId))
    .where(
      and(
        ...scope(accountId, companyId),
        isNotNull(expenseAllocations.jobId),
        ...(jobIds ? [inArray(expenseAllocations.jobId, jobIds)] : []),
      ),
    );
  for (const row of direct) add(row.jobId, row.amount, row.share);

  const viaInvoice = await tx
    .select({
      jobId: invoices.jobId,
      amount: expenses.amount,
      share: expenseAllocations.share,
    })
    .from(expenseAllocations)
    .innerJoin(expenses, eq(expenses.id, expenseAllocations.expenseId))
    .innerJoin(invoices, eq(invoices.id, expenseAllocations.invoiceId))
    .where(
      and(
        ...scope(accountId, companyId),
        isNotNull(invoices.jobId),
        ...(jobIds ? [inArray(invoices.jobId, jobIds)] : []),
      ),
    );
  for (const row of viaInvoice) add(row.jobId, row.amount, row.share);

  return byJob;
}

// What each job has billed, in cents. SUBTOTAL, not total: sales tax collected
// is not the user's money, and counting it would inflate every taxed job.
export async function jobBilledCents(
  tx: Transaction,
  accountId: string,
  companyId: string,
  jobIds?: string[],
): Promise<Map<string, number>> {
  const byJob = new Map<string, number>();
  if (jobIds && jobIds.length === 0) return byJob;

  const rows = await tx
    .select({ jobId: invoices.jobId, subtotal: invoices.subtotal })
    .from(invoices)
    .where(
      and(
        eq(invoices.accountId, accountId),
        eq(invoices.companyId, companyId),
        isNotNull(invoices.jobId),
        inArray(invoices.status, [...BILLED_INVOICE_STATUSES]),
        ...(jobIds ? [inArray(invoices.jobId, jobIds)] : []),
      ),
    );
  for (const row of rows) {
    if (!row.jobId) continue;
    byJob.set(row.jobId, (byJob.get(row.jobId) ?? 0) + Math.round(Number(row.subtotal) * 100));
  }
  return byJob;
}

// Tracked minutes per job. Every entry counts, billed or not — hours are what
// the work cost in time, and whether they were invoiced is a separate question.
export async function jobMinutes(
  tx: Transaction,
  accountId: string,
  companyId: string,
  jobIds?: string[],
): Promise<Map<string, number>> {
  const byJob = new Map<string, number>();
  if (jobIds && jobIds.length === 0) return byJob;

  const rows = await tx
    .select({
      jobId: timeEntries.jobId,
      minutes: sql<string>`coalesce(sum(${timeEntries.minutes}), 0)`,
    })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.accountId, accountId),
        eq(timeEntries.companyId, companyId),
        ...(jobIds ? [inArray(timeEntries.jobId, jobIds)] : []),
      ),
    )
    .groupBy(timeEntries.jobId);
  for (const row of rows) byJob.set(row.jobId, Number(row.minutes));
  return byJob;
}

// What an hour on this job actually paid: (billed - costs) / hours.
//
// This is the number time tracking exists to produce, and it is a REPORTING
// LENS, never a ledger posting. The owner's own labour is not a deductible
// expense — no payroll, no wage entry, money taken out is a draw against equity
// — so hours must never be subtracted into margin as if they were a cost. They
// divide it instead, which answers "was this job worth my time" without
// pretending the time was an expense.
//
// Null when no hours are tracked: a job with no time entries has no meaningful
// hourly rate, and 0 would read as "this job paid nothing an hour".
export function effectiveHourly(madeCents: number, minutes: number): string | null {
  if (minutes <= 0) return null;
  return centsToMoney(Math.round((madeCents * 60) / minutes));
}

// --- Billing tracked time onto an invoice -----------------------------------

export type BillTimeError = { error: string; status: 400 | 404 | 409 };

// A job named on an invoice has to exist inside the same account AND the same
// company. RLS pins the account only, so without the company half an invoice
// could join a job belonging to a sibling company in the same workspace —
// exactly the hole the expense-allocation endpoint guards against.
export async function assertJobInCompany(
  tx: Transaction,
  accountId: string,
  companyId: string,
  jobId: string | null | undefined,
): Promise<BillTimeError | null> {
  if (!jobId) return null;
  const [job] = await tx
    .select({ id: jobs.id, companyId: jobs.companyId })
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.accountId, accountId)))
    .limit(1);
  if (!job) return { error: 'job_not_found', status: 404 };
  if (job.companyId !== companyId) return { error: 'job_company_mismatch', status: 400 };
  return null;
}

// Attach a set of time entries to an invoice, and release any the invoice used
// to carry that are no longer in the set.
//
// The client has ALREADY built the hour lines and computed the totals — money
// math is client-side and stored as-sent, so appending lines here would be a
// second totals path free to disagree with the first. All this does is record
// which entries that invoice consumed, in the same transaction, so they can't be
// billed twice.
//
// Replace semantics, matching how line items behave on PATCH. Callers pass
// undefined to mean "don't touch"; an explicit array (including an empty one)
// replaces the set.
export async function applyBilledTimeEntries(
  tx: Transaction,
  accountId: string,
  companyId: string,
  invoiceId: string,
  invoiceJobId: string | null,
  ids: string[],
): Promise<BillTimeError | null> {
  // Release first, so moving an entry off an invoice and onto another in the
  // same edit doesn't trip the already-billed guard below.
  const releaseWhere = [
    eq(timeEntries.accountId, accountId),
    eq(timeEntries.billedInvoiceId, invoiceId),
    ...(ids.length > 0 ? [notInArray(timeEntries.id, ids)] : []),
  ];
  await tx
    .update(timeEntries)
    .set({ billedInvoiceId: null, updatedAt: new Date() })
    .where(and(...releaseWhere));

  if (ids.length === 0) return null;

  // Hours belong to a job, so an invoice billing them has to be on that job.
  // Without this an hour line could be sold from an invoice with no job at all,
  // and the entry would be marked billed with nothing tying the two together.
  if (!invoiceJobId) return { error: 'invoice_has_no_job', status: 400 };

  const rows = await tx
    .select({
      id: timeEntries.id,
      companyId: timeEntries.companyId,
      jobId: timeEntries.jobId,
      billedInvoiceId: timeEntries.billedInvoiceId,
    })
    .from(timeEntries)
    .where(and(eq(timeEntries.accountId, accountId), inArray(timeEntries.id, ids)));

  if (rows.length !== new Set(ids).size) return { error: 'time_entry_not_found', status: 404 };
  // RLS pins the account, never the company — this check is ours to make.
  if (rows.some((r) => r.companyId !== companyId)) {
    return { error: 'time_entry_company_mismatch', status: 400 };
  }
  if (rows.some((r) => r.jobId !== invoiceJobId)) {
    return { error: 'time_entry_job_mismatch', status: 400 };
  }
  if (rows.some((r) => r.billedInvoiceId !== null && r.billedInvoiceId !== invoiceId)) {
    return { error: 'time_entry_already_billed', status: 409 };
  }

  await tx
    .update(timeEntries)
    .set({ billedInvoiceId: invoiceId, updatedAt: new Date() })
    .where(and(eq(timeEntries.accountId, accountId), inArray(timeEntries.id, ids)));
  return null;
}

// Minutes rendered as a 2dp hours string for display ("195" -> "3.25"). Distinct
// from hoursFromMinutes in @thalermark/validation, which produces the 4dp
// QUANTITY string an invoice line stores; this one is for reading.
export function displayHours(minutes: number): string {
  return (Math.round((minutes / 60) * 100) / 100).toFixed(2);
}
