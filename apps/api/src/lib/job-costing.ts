import {
  type Transaction,
  expenseAllocations,
  expenses,
  invoices,
  jobs,
  timeEntries,
} from '@thalermark/db';
import { centsToMoney, hoursFromMinutes, multiplyMoney, toCents } from '@thalermark/validation';
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

// Written but not yet sent. Its own number rather than a member of either
// neighbour, because a draft is genuinely a third state and folding it into one
// of the other two is wrong in a different direction each way (TMC-202):
//
//   into BILLED  → "made" starts counting money nobody has been asked for
//   into READY   → the same hours get billed twice, which is TMC-200
//
// Without it the money is in NEITHER: the hours are stamped (so not ready) and
// the invoice is unsent (so not billed), and a job holding a real draft invoice
// reports zero across every tile.
export const DRAFT_INVOICE_STATUSES = ['draft'] as const;

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

// Per-job invoice subtotals for a set of statuses, in cents. SUBTOTAL, not
// total: sales tax collected is not the user's money, and counting it would
// inflate every taxed job.
//
// The status list is the ONLY difference between the billed and drafted
// figures, so it is a parameter rather than a second copy of this query — the
// drift this file's header warns about is exactly how the voided-invoice bug
// (TMC-183) got in.
async function jobInvoicedCents(
  tx: Transaction,
  accountId: string,
  companyId: string,
  statuses: readonly string[],
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
        inArray(invoices.status, [...statuses]),
        ...(jobIds ? [inArray(invoices.jobId, jobIds)] : []),
      ),
    );
  for (const row of rows) {
    if (!row.jobId) continue;
    byJob.set(row.jobId, (byJob.get(row.jobId) ?? 0) + Math.round(Number(row.subtotal) * 100));
  }
  return byJob;
}

// What each job has actually billed — invoices that reached the customer.
export function jobBilledCents(
  tx: Transaction,
  accountId: string,
  companyId: string,
  jobIds?: string[],
): Promise<Map<string, number>> {
  return jobInvoicedCents(tx, accountId, companyId, BILLED_INVOICE_STATUSES, jobIds);
}

// What each job has written but not sent. Disjoint from jobBilledCents by
// construction — the two status lists cannot overlap — so a caller can show
// both without double-counting a penny.
export function jobDraftedCents(
  tx: Transaction,
  accountId: string,
  companyId: string,
  jobIds?: string[],
): Promise<Map<string, number>> {
  return jobInvoicedCents(tx, accountId, companyId, DRAFT_INVOICE_STATUSES, jobIds);
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
// Null in two cases, and both mean "there is no answer yet" rather than "the
// answer is zero":
//
//   - no hours tracked — nothing to divide by
//   - nothing billed yet — the job hasn't earned anything to divide
//
// The second matters more than it looks. A job with an hour logged and no
// invoice would otherwise render "$0.00 per hour", which reads as a verdict on
// the work when it is really just a job that hasn't been billed. A dash says
// "you haven't told me"; a number says "here is the answer".
//
// Once something IS billed the number always shows, including zero and negative
// — a job that billed $100 and cost $100 really did pay $0/hr, and one that lost
// money should say so.
export function effectiveHourly(
  madeCents: number,
  minutes: number,
  billedCents: number,
): string | null {
  if (minutes <= 0 || billedCents <= 0) return null;
  return centsToMoney(Math.round((madeCents * 60) / minutes));
}

// What a job made — null until any of its revenue is recognised (TMC-203).
//
// `billed - costs` with nothing billed is not a loss, it is the NEGATIVE OF THE
// COSTS, and printing it breaks the matching principle: the cost is reported
// while the revenue that justifies it is not. A landscaper who spent $340 of
// plants on a job invoiced but not yet sent has not lost $340 — those costs are
// work in progress, and the margin is not knowable until the revenue lands.
//
// Counting a draft as revenue instead would be the opposite error. An unsent
// invoice has no issue date, and the ledger recognises invoice revenue ON the
// issue date, so the report would run ahead of the books.
//
// The guard is `billedCents <= 0`, identical to effectiveHourly above — this is
// not a new policy, it is the one already applied to the per-hour figure, which
// has always refused to state a rate with nothing billed. `made` simply never
// followed it.
//
// A job with SOME revenue recognised and a draft still outstanding does state a
// margin, against all of its costs. That figure is provisional rather than
// wrong, and the `drafted` amount is reported beside it so the reader can see
// the job is not finished.
export function jobMade(billedCents: number, costCents: number): string | null {
  if (billedCents <= 0) return null;
  return centsToMoney(billedCents - costCents);
}

// What each job could invoice right now: tracked hours no invoice has claimed.
//
// Only entries carrying a RATE. Unrated hours bill nothing, so folding them in
// at zero would say "nothing waiting" about work that simply has not been
// priced — which is why unratedMinutes comes back alongside and the surfaces
// render it as its own caveat.
//
// Priced through hoursFromMinutes + multiplyMoney, the same 4dp path the invoice
// form uses. A "ready to bill" that disagrees with the invoice it produces is
// worse than not showing one.
export async function jobUnbilled(
  tx: Transaction,
  accountId: string,
  companyId: string,
  jobIds?: string[],
): Promise<Map<string, { cents: number; unratedMinutes: number }>> {
  const byJob = new Map<string, { cents: number; unratedMinutes: number }>();
  if (jobIds && jobIds.length === 0) return byJob;

  const rows = await tx
    .select({
      jobId: timeEntries.jobId,
      minutes: timeEntries.minutes,
      rate: timeEntries.rate,
    })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.accountId, accountId),
        eq(timeEntries.companyId, companyId),
        isNull(timeEntries.billedInvoiceId),
        ...(jobIds ? [inArray(timeEntries.jobId, jobIds)] : []),
      ),
    );

  for (const row of rows) {
    const at = byJob.get(row.jobId) ?? { cents: 0, unratedMinutes: 0 };
    if (row.rate === null) {
      at.unratedMinutes += row.minutes;
    } else {
      at.cents += toCents(multiplyMoney(hoursFromMinutes(row.minutes), row.rate));
    }
    byJob.set(row.jobId, at);
  }
  return byJob;
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

// Billing tracked time is split into a READ half and a WRITE half, and callers
// must run the read half before they write anything.
//
// Why: the tenant transaction only rolls back on a THROWN error (see
// middleware/rls-context.ts — `if (c.error) throw c.error`). A handler that
// *returns* c.json({error}, 409) completes normally and the transaction
// COMMITS. So a validation failure discovered after the invoice insert would
// leave a real, numbered invoice on the books with its hour lines, while the
// time entries stayed unbilled — free to be billed again onto a second invoice.
// The customer gets charged twice and the books show it.
//
// Validating first makes that unreachable rather than merely unlikely.

// Read half. No writes, safe to call before anything is inserted.
//
// currentInvoiceId is the invoice being edited, so entries already billed to
// THIS invoice pass; it is null on create, where nothing can legitimately be
// billed to an invoice that does not exist yet.
export async function validateBilledTimeEntries(
  tx: Transaction,
  accountId: string,
  companyId: string,
  invoiceJobId: string | null,
  ids: string[],
  currentInvoiceId: string | null,
): Promise<BillTimeError | null> {
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
  if (rows.some((r) => r.billedInvoiceId !== null && r.billedInvoiceId !== currentInvoiceId)) {
    return { error: 'time_entry_already_billed', status: 409 };
  }
  return null;
}

// Write half. Records which entries an invoice consumed and releases any it used
// to carry that are no longer in the set, so nothing is billed twice.
//
// The client has ALREADY built the hour lines and computed the totals — money
// math is client-side and stored as-sent, so appending lines here would be a
// second totals path free to disagree with the first.
//
// Replace semantics, matching how line items behave on PATCH. Callers pass
// undefined to mean "don't touch"; an explicit array (including an empty one)
// replaces the set.
export async function stampBilledTimeEntries(
  tx: Transaction,
  accountId: string,
  invoiceId: string,
  ids: string[],
): Promise<void> {
  // Release first, so moving an entry off one invoice and onto another in the
  // same edit doesn't collide with itself.
  await tx
    .update(timeEntries)
    .set({ billedInvoiceId: null, updatedAt: new Date() })
    .where(
      and(
        eq(timeEntries.accountId, accountId),
        eq(timeEntries.billedInvoiceId, invoiceId),
        ...(ids.length > 0 ? [notInArray(timeEntries.id, ids)] : []),
      ),
    );

  if (ids.length === 0) return;

  await tx
    .update(timeEntries)
    .set({ billedInvoiceId: invoiceId, updatedAt: new Date() })
    .where(and(eq(timeEntries.accountId, accountId), inArray(timeEntries.id, ids)));
}

// Minutes rendered as a 2dp hours string for display ("195" -> "3.25"). Distinct
// from hoursFromMinutes in @thalermark/validation, which produces the 4dp
// QUANTITY string an invoice line stores; this one is for reading.
export function displayHours(minutes: number): string {
  return (Math.round((minutes / 60) * 100) / 100).toFixed(2);
}
