import {
  type Database,
  type Transaction,
  contacts,
  estimates,
  invoicePayments,
  invoices,
} from '@thalermark/db';
import { centsToMoney, toCents } from '@thalermark/validation';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { medianCents } from './send-check.js';

// What one customer is actually worth, and whether they pay.
//
// The contact page describes a commercial relationship and renders a mailing
// address. Every number below already existed somewhere in the product —
// computed company-wide, for a report nobody opens while looking at a customer.
// This moves them to where the question gets asked.
//
// FIVE INDEX-BACKED READS, A CONSTANT. Never a query per invoice, per month or
// per estimate. This is a detail page answering four independent questions; the
// honest precedents nearby are the two of payment-reliability and the three of
// A/R aging.
//
// No LLM, no stored aggregate, no cache table. Same posture as the send-check:
// deterministic, instant, free, identical every time.

export type CustomerReliability = {
  paidCount: number;
  lateCount: number;
  onTimeCount: number;
  latePct: number | null;
  avgDaysLate: number | null;
  overdueCount: number;
  overdueTotal: string;
};

export type CustomerInsights = {
  billed: { last12: string; allTime: string; invoiceCount: number };
  owed: { amount: string; overdueCount: number; overdueAmount: string };
  typical: { median: string | null; recent: string[] };
  months: { month: string; billed: string }[];
  estimates: { accepted: number; declined: number; answered: number; open: number; lapsed: number };
  reliability: CustomerReliability;
  firstInvoiceOn: string | null;
  lastInvoiceOn: string | null;
};

// PRE-TAX EVERYWHERE MONEY IS EARNED, GROSS WHERE MONEY IS OWED.
//
// `billed` and the monthly series read `subtotal`, because sales tax collected
// was never the operator's money — the same call TMC-254 made for cash-basis
// gross receipts, and the same one job costing and sales-by-customer already
// made. `owed` reads `total`, because the customer owes the tax too: it is on
// the invoice they were sent. The two are different questions and the columns
// have to differ with them.
const BILLED = sql<string>`coalesce(sum(${invoices.subtotal}) filter (where ${invoices.status} in ('sent','paid')), 0)::numeric(15,2)`;

// The reliability half, extracted verbatim from the payment-reliability route so
// the two endpoints cannot drift. "Late" = paid after the due date; avgDaysLate
// is averaged over the LATE invoices only, so a far-out due date can't swing it.
function reliabilityColumns(todayYmd: string, owedExpr: ReturnType<typeof sql>) {
  return {
    paidCount: sql<number>`count(*) filter (where ${invoices.paidAt} is not null)::int`,
    lateCount: sql<number>`count(*) filter (where ${invoices.paidAt} is not null and (${invoices.paidAt} at time zone 'UTC')::date > ${invoices.dueDate})::int`,
    avgDaysLate: sql<
      number | null
    >`round(avg((${invoices.paidAt} at time zone 'UTC')::date - ${invoices.dueDate}) filter (where ${invoices.paidAt} is not null and (${invoices.paidAt} at time zone 'UTC')::date > ${invoices.dueDate}))::int`,
    overdueCount: sql<number>`count(*) filter (where ${invoices.status} = 'sent' and ${invoices.dueDate} < ${todayYmd})::int`,
    // NET OF PAYMENTS, which the original was not.
    //
    // payment-reliability summed the full invoice total, so a $1,000 invoice
    // carrying a $600 deposit reported $1,000 overdue while A/R aging reported
    // $400 for the same invoice. That is the TMC-216 defect again — the same
    // one TMC-253 fixed on the statement and TMC-254 on the tax worksheet — and
    // fixing it here is what lets the contact page show one overdue figure
    // instead of two.
    overdueTotal: sql<string>`coalesce(sum(${owedExpr}) filter (where ${invoices.status} = 'sent' and ${invoices.dueDate} < ${todayYmd}), 0)::numeric(15,2)`,
  };
}

export function summariseReliability(row: {
  paidCount: number;
  lateCount: number;
  avgDaysLate: number | null;
  overdueCount: number;
  overdueTotal: string;
}): CustomerReliability {
  return {
    paidCount: row.paidCount,
    lateCount: row.lateCount,
    onTimeCount: row.paidCount - row.lateCount,
    latePct: row.paidCount > 0 ? Math.round((row.lateCount / row.paidCount) * 100) : null,
    avgDaysLate: row.avgDaysLate,
    overdueCount: row.overdueCount,
    overdueTotal: row.overdueTotal,
  };
}

// The reliability figures alone, for the endpoint that only wants those. Both
// routes call into this file so "pays late 3 of 7 times" is one piece of SQL
// rather than two that look alike.
export async function buildCustomerReliability(
  tx: Database | Transaction,
  accountId: string,
  customerId: string,
): Promise<CustomerReliability | null> {
  const [customer] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.id, customerId), eq(contacts.accountId, accountId)))
    .limit(1);
  if (!customer) return null;

  const paid = paidPerInvoice(tx, accountId);
  const owed = sql`${invoices.total} - coalesce(${paid.paid}, 0)`;
  const [row] = await tx
    .select(reliabilityColumns(todayYmd(), owed))
    .from(invoices)
    .leftJoin(paid, eq(paid.invoiceId, invoices.id))
    .where(and(eq(invoices.accountId, accountId), eq(invoices.contactId, customerId)));

  return summariseReliability({
    paidCount: row?.paidCount ?? 0,
    lateCount: row?.lateCount ?? 0,
    avgDaysLate: row?.avgDaysLate ?? null,
    overdueCount: row?.overdueCount ?? 0,
    overdueTotal: row?.overdueTotal ?? '0.00',
  });
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

// One row per invoice, so joining it can never multiply a count. Lifted from the
// invoices summary endpoint, which needed the same thing for the same reason.
function paidPerInvoice(tx: Database | Transaction, accountId: string) {
  return tx
    .select({
      invoiceId: invoicePayments.invoiceId,
      paid: sql<string>`sum(${invoicePayments.amount})`.as('paid'),
    })
    .from(invoicePayments)
    .where(eq(invoicePayments.accountId, accountId))
    .groupBy(invoicePayments.invoiceId)
    .as('paid_per_invoice');
}

export async function buildCustomerInsights(
  tx: Database | Transaction,
  accountId: string,
  customerId: string,
): Promise<CustomerInsights | null> {
  // Read 1 — the contact, which is both the 404 gate and where companyId comes
  // from. RLS pins the ACCOUNT only, so every company-scoped read below filters
  // company_id explicitly, and it is resolved here rather than taken from a
  // query parameter or the client's active company. A contact belongs to exactly
  // one company; buildCustomerStatement resolves it the same way.
  const [customer] = await tx
    .select({ id: contacts.id, companyId: contacts.companyId })
    .from(contacts)
    .where(and(eq(contacts.id, customerId), eq(contacts.accountId, accountId)))
    .limit(1);
  if (!customer) return null;

  const { companyId } = customer;
  const today = todayYmd();
  const scope = and(
    eq(invoices.accountId, accountId),
    eq(invoices.companyId, companyId),
    eq(invoices.contactId, customerId),
  );
  // Twelve months back from the first of the current month, so "last 12 months"
  // is twelve whole months and not eleven and a fraction.
  const monthStart = `${today.slice(0, 7)}-01`;
  const windowStart = new Date(`${monthStart}T00:00:00Z`);
  windowStart.setUTCMonth(windowStart.getUTCMonth() - 11);
  const from = windowStart.toISOString().slice(0, 10);

  const paid = paidPerInvoice(tx, accountId);
  const owedExpr = sql`${invoices.total} - coalesce(${paid.paid}, 0)`;

  // Read 2 — every scalar about this customer's invoices, in one pass.
  const [totals] = await tx
    .select({
      invoiceCount: sql<number>`count(*) filter (where ${invoices.status} in ('sent','paid'))::int`,
      billedAllTime: BILLED,
      billedLast12: sql<string>`coalesce(sum(${invoices.subtotal}) filter (where ${invoices.status} in ('sent','paid') and ${invoices.issueDate} >= ${from}), 0)::numeric(15,2)`,
      // A 'sent' invoice always has something left on it — settlement flips the
      // status the moment the balance reaches zero — so this needs no positive
      // filter to match what A/R aging reports.
      owedAmount: sql<string>`coalesce(sum(${owedExpr}) filter (where ${invoices.status} = 'sent'), 0)::numeric(15,2)`,
      firstInvoiceOn: sql<
        string | null
      >`min(${invoices.issueDate}) filter (where ${invoices.status} in ('sent','paid'))`,
      lastInvoiceOn: sql<
        string | null
      >`max(${invoices.issueDate}) filter (where ${invoices.status} in ('sent','paid'))`,
      ...reliabilityColumns(today, owedExpr),
    })
    .from(invoices)
    .leftJoin(paid, eq(paid.invoiceId, invoices.id))
    .where(scope);

  // Read 3 — the last five ISSUED invoices, the identical predicate and order
  // the send-check uses for its priors.
  //
  // Drafts are excluded by `sentAt IS NOT NULL`, which is also why the two
  // agree at the only moment it matters: while the invoice being sent is still a
  // draft it is absent from both sets, so the median this page shows is the
  // median that warning is about to compare against. Ordered by issue date
  // rather than creation, so "what you usually bill them" means recent work
  // rather than recent typing.
  const recent = await tx
    .select({ total: invoices.total })
    .from(invoices)
    .where(and(scope, inArray(invoices.status, ['sent', 'paid']), isNotNull(invoices.sentAt)))
    .orderBy(desc(invoices.issueDate), desc(invoices.createdAt))
    .limit(5);

  // Read 4 — the monthly series. Present months only; the client fills the gaps,
  // exactly as the company revenue report does.
  const monthExpr = sql<string>`to_char(date_trunc('month', ${invoices.issueDate}), 'YYYY-MM')`;
  const months = await tx
    .select({
      month: monthExpr,
      billed: BILLED,
    })
    .from(invoices)
    .where(and(scope, sql`${invoices.issueDate} >= ${from}`))
    .groupBy(monthExpr)
    .orderBy(monthExpr);

  // Read 5 — estimates.
  //
  // LAPSED IS COUNTED, BUT NOT AS A DECISION (owner call, 2026-08-11). An
  // estimate that expired unanswered is not a "no": the customer said nothing,
  // and the expiry date was chosen by the operator, so folding it into the
  // denominator would move a customer's accept rate because someone typed 30
  // days instead of 90. It is also not terminal the way declined is — people
  // call in March about a January price. So the accept rate is off ANSWERED
  // estimates, and lapsed is reported beside it as its own fact.
  //
  // `expired` is never a stored status: no transition writes it and expiry is
  // advisory-at-read off expires_on. It is derived here for the same reason.
  // Drafts are excluded throughout — an estimate never sent is not a question
  // the customer was ever asked.
  const [est] = await tx
    .select({
      accepted: sql<number>`count(*) filter (where ${estimates.status} = 'accepted')::int`,
      declined: sql<number>`count(*) filter (where ${estimates.status} = 'declined')::int`,
      lapsed: sql<number>`count(*) filter (where ${estimates.status} = 'sent' and ${estimates.expiresOn} is not null and ${estimates.expiresOn} < ${today})::int`,
      open: sql<number>`count(*) filter (where ${estimates.status} = 'sent' and (${estimates.expiresOn} is null or ${estimates.expiresOn} >= ${today}))::int`,
    })
    .from(estimates)
    .where(
      and(
        eq(estimates.accountId, accountId),
        eq(estimates.companyId, companyId),
        eq(estimates.contactId, customerId),
      ),
    );

  const recentTotals = recent.map((r) => r.total);
  const accepted = est?.accepted ?? 0;
  const declined = est?.declined ?? 0;

  return {
    billed: {
      last12: totals?.billedLast12 ?? '0.00',
      allTime: totals?.billedAllTime ?? '0.00',
      invoiceCount: totals?.invoiceCount ?? 0,
    },
    owed: {
      amount: totals?.owedAmount ?? '0.00',
      overdueCount: totals?.overdueCount ?? 0,
      overdueAmount: totals?.overdueTotal ?? '0.00',
    },
    typical: {
      // The same median function the send-check uses, imported rather than
      // reimplemented. If this page says "usually about $400" and the warning
      // fires against a different figure, the feature is worse than nothing.
      median: recentTotals.length > 0 ? centsToMoney(medianCents(recentTotals.map(toCents))) : null,
      recent: recentTotals,
    },
    months,
    estimates: {
      accepted,
      declined,
      answered: accepted + declined,
      open: est?.open ?? 0,
      lapsed: est?.lapsed ?? 0,
    },
    reliability: summariseReliability({
      paidCount: totals?.paidCount ?? 0,
      lateCount: totals?.lateCount ?? 0,
      avgDaysLate: totals?.avgDaysLate ?? null,
      overdueCount: totals?.overdueCount ?? 0,
      overdueTotal: totals?.overdueTotal ?? '0.00',
    }),
    firstInvoiceOn: totals?.firstInvoiceOn ?? null,
    lastInvoiceOn: totals?.lastInvoiceOn ?? null,
  };
}
