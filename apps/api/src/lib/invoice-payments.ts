import { type Database, type Invoice, type Transaction, invoicePayments } from '@thalermark/db';
import { invoices } from '@thalermark/db';
import { centsToMoney, toCents } from '@thalermark/validation';
import { and, desc, eq, sql } from 'drizzle-orm';
import { reindexEntities } from './search/reindex.js';

// Deriving settlement from payment rows (TMC-187).
//
// invoices.status stays a two-value column for the settled question — 'sent' or
// 'paid' — because the whole ledger, every report and both clients already read
// it and a third value would have to be understood everywhere at once. What is
// NEW is that the column is no longer the authority: the payment rows are, and
// the column is maintained to agree with them.
//
// The richer answer a user actually wants — is this half paid? overpaid? — is
// the `settlement` label below, derived at read time and never stored. Nothing
// can drift out of sync with a value that is computed.

export type InvoiceSettlement = 'unpaid' | 'partial' | 'paid' | 'overpaid';

export type SettlementSummary = {
  settlement: InvoiceSettlement;
  // Decimal strings, like every money value crossing the API.
  paid: string;
  outstanding: string;
  // What invoices.status must be for this summary to be consistent. The write
  // paths set the column from this rather than reasoning about it inline, so
  // there is exactly one place the mapping lives.
  status: 'sent' | 'paid';
};

// Pure: given an invoice total and what has been received against it, say where
// it stands. Cents throughout — money arithmetic never touches floats.
//
// Overpaid is a real, reachable state and is deliberately NOT an error. A
// customer can pay $1,300 on a $1,200 invoice, and refusing to record what
// actually happened is worse than showing it. It maps to status 'paid': the
// invoice is settled, and then some.
//
// A fully refunded invoice (payments netting to zero or below) reads 'unpaid'
// and returns to 'sent' — it is owed again, which is exactly true.
export function summarizeSettlement(args: {
  totalCents: number;
  paidCents: number;
}): SettlementSummary {
  const { totalCents, paidCents } = args;
  const outstandingCents = totalCents - paidCents;

  if (paidCents <= 0) {
    return {
      settlement: 'unpaid',
      paid: centsToMoney(paidCents),
      outstanding: centsToMoney(outstandingCents),
      status: 'sent',
    };
  }
  if (outstandingCents > 0) {
    return {
      settlement: 'partial',
      paid: centsToMoney(paidCents),
      outstanding: centsToMoney(outstandingCents),
      status: 'sent',
    };
  }
  return {
    settlement: outstandingCents < 0 ? 'overpaid' : 'paid',
    paid: centsToMoney(paidCents),
    outstanding: centsToMoney(outstandingCents),
    status: 'paid',
  };
}

// Sum of every receipt against one invoice, in cents. Signed, so refunds net
// themselves out. Filters accountId as well as invoiceId — defence in depth
// beside RLS, and it keeps the read on the (account_id, invoice_id) index.
export async function paidCentsForInvoice(
  tx: Database | Transaction,
  args: { accountId: string; invoiceId: string },
): Promise<number> {
  const [row] = await tx
    .select({
      paid: sql<string>`coalesce(sum(${invoicePayments.amount}), 0)::numeric(15,2)`,
      count: sql<number>`count(*)::int`,
    })
    .from(invoicePayments)
    .where(
      and(
        eq(invoicePayments.accountId, args.accountId),
        eq(invoicePayments.invoiceId, args.invoiceId),
      ),
    );
  return toCents(row?.paid ?? '0.00');
}

// How many receipts exist for an invoice. Needed on its own, not just as a sum,
// because of the legacy guard below: zero rows on a paid invoice means it was
// settled through the old header-only path.
export async function paymentCountForInvoice(
  tx: Database | Transaction,
  args: { accountId: string; invoiceId: string },
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(invoicePayments)
    .where(
      and(
        eq(invoicePayments.accountId, args.accountId),
        eq(invoicePayments.invoiceId, args.invoiceId),
      ),
    );
  return Number(row?.count ?? 0);
}

export type PaymentEligibility =
  | { ok: true }
  | { ok: false; reason: 'not_issued' | 'voided' | 'settled_without_payments' };

// May a receipt be recorded against this invoice?
//
// 'sent' — yes. This is the ordinary case, including the first deposit.
//
// 'draft' — no. A payment relieves accounts receivable and a draft has posted
// none; there is literally nothing to pay down. Issue it first.
//
// 'voided' — no. The document was cancelled and its revenue reversed.
//
// 'paid' — only if it got there THROUGH payment rows. This is the guard that
// makes the change safe to ship against live data: an invoice settled by the
// old single-shot mark-paid carries header stamps and no rows, and its cash is
// already on the books. Accepting a payment against it would post the money a
// second time. An invoice paid through rows, by contrast, must stay open to a
// refund or a correction — otherwise the only way to fix a mistake would be to
// void a legitimately paid invoice.
export function checkPaymentEligibility(args: {
  status: string;
  existingPaymentCount: number;
}): PaymentEligibility {
  if (args.status === 'draft') return { ok: false, reason: 'not_issued' };
  if (args.status === 'voided') return { ok: false, reason: 'voided' };
  if (args.status === 'paid' && args.existingPaymentCount === 0) {
    return { ok: false, reason: 'settled_without_payments' };
  }
  return { ok: true };
}

// Re-derives settlement from the payment rows and writes the invoice header to
// agree with it. Called after every payment insert and delete — it is the ONLY
// place invoices.status moves as a result of money arriving, so the column and
// the rows cannot disagree.
//
// The legacy header columns are maintained rather than abandoned. paid_at,
// payment_method and payment_reference are read by the public invoice view, the
// customer statement, both clients and the reports, and having them keep saying
// what they always said is what makes this change additive. They now mirror the
// MOST RECENT receipt: for the single-payment case — still the common one —
// that is byte-identical to what mark-paid used to write.
//
// Returns the updated invoice, or null if it vanished (concurrent void/delete).
export async function syncInvoiceSettlement(
  tx: Database | Transaction,
  args: { accountId: string; invoiceId: string; totalCents: number },
): Promise<{ invoice: Invoice; summary: SettlementSummary } | null> {
  const paidCents = await paidCentsForInvoice(tx, {
    accountId: args.accountId,
    invoiceId: args.invoiceId,
  });
  const summary = summarizeSettlement({ totalCents: args.totalCents, paidCents });

  // The receipt whose details the header mirrors: latest by the date the money
  // arrived, then by id so a same-day pair is still deterministic (uuidv7 is
  // time-ordered, so the tiebreak is insertion order).
  const [latest] = await tx
    .select()
    .from(invoicePayments)
    .where(
      and(
        eq(invoicePayments.accountId, args.accountId),
        eq(invoicePayments.invoiceId, args.invoiceId),
      ),
    )
    .orderBy(desc(invoicePayments.receivedOn), desc(invoicePayments.id))
    .limit(1);

  const settled = summary.status === 'paid';
  const [updated] = await tx
    .update(invoices)
    .set({
      status: summary.status,
      updatedAt: new Date(),
      // Cleared when the invoice falls back to open — a refund that reopens an
      // invoice must not leave a paid_at behind claiming it was settled.
      paidAt: settled && latest ? new Date(`${latest.receivedOn}T00:00:00.000Z`) : null,
      paymentMethod: settled && latest ? latest.method : null,
      paymentReference: settled && latest ? latest.reference : null,
      processingFee: settled && latest ? latest.processingFee : null,
    })
    .where(and(eq(invoices.id, args.invoiceId), eq(invoices.accountId, args.accountId)))
    .returning();

  // Reproject here rather than at the four call sites (TMC-198). This function
  // writes no audit event of its own, so the audit-driven reindex cannot see
  // it — yet every path that can change an invoice's settlement status runs
  // through here: manual mark-paid, a partial payment, a payment removal that
  // reopens the invoice, and the Stripe webhook. One call covers all four, and
  // covers the fifth that gets written next year.
  if (updated) {
    await reindexEntities(tx, args.accountId, [
      { entityType: 'invoice', entityId: args.invoiceId },
    ]);
  }

  return updated ? { invoice: updated, summary } : null;
}
