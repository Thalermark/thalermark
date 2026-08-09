import { type Bill, type Database, type Transaction, billPayments, bills } from '@thalermark/db';
import { toCents } from '@thalermark/validation';
import { and, desc, eq, sql } from 'drizzle-orm';
import { type SettlementSummary, summarizeSettlement } from './invoice-payments.js';

// Deriving a bill's settlement from its payment rows (TMC-192) — the
// accounts-payable mirror of invoice-payments.ts.
//
// bills.status stays a three-value column — 'open' | 'paid' | 'voided' — because
// the AP aging report, the ledger paths and both clients already read it. What
// is NEW is that it is no longer the authority for the settled question: the
// payment rows are, and the column is maintained to agree with them.
//
// The richer answer — is this half paid? overpaid? — is the settlement label,
// derived at read time and never stored. Nothing can drift out of sync with a
// value that is computed.
//
// summarizeSettlement is reused verbatim from the invoice half rather than
// copied: it is already entity-agnostic, taking a total and what has been paid
// against it. The ONLY thing that does not carry over is the status it suggests,
// which speaks invoice ('sent' | 'paid'). billStatusFor translates that one
// field, and is the whole of the difference.

export type BillSettlementSummary = Omit<SettlementSummary, 'status'> & {
  // What bills.status must be for this summary to be consistent. 'voided' is
  // absent on purpose: voiding is a decision a user makes, not something that
  // falls out of the arithmetic, and a voided bill never reaches here.
  status: 'open' | 'paid';
};

export function summarizeBillSettlement(args: {
  amountCents: number;
  paidCents: number;
}): BillSettlementSummary {
  const summary = summarizeSettlement({
    totalCents: args.amountCents,
    paidCents: args.paidCents,
  });
  return { ...summary, status: summary.status === 'paid' ? 'paid' : 'open' };
}

// Sum of every payment against one bill, in cents. Signed, so a vendor refund
// nets itself out. Filters accountId as well as billId — defence in depth beside
// RLS, and it keeps the read on the (account_id, bill_id) index.
export async function paidCentsForBill(
  tx: Database | Transaction,
  args: { accountId: string; billId: string },
): Promise<number> {
  const [row] = await tx
    .select({ paid: sql<string>`coalesce(sum(${billPayments.amount}), 0)::numeric(15,2)` })
    .from(billPayments)
    .where(and(eq(billPayments.accountId, args.accountId), eq(billPayments.billId, args.billId)));
  return toCents(row?.paid ?? '0.00');
}

// How many payments exist for a bill. Needed on its own, not just as a sum,
// because of the legacy guard below: zero rows on a paid bill means it was
// settled through the old header-only mark-paid path.
export async function paymentCountForBill(
  tx: Database | Transaction,
  args: { accountId: string; billId: string },
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(billPayments)
    .where(and(eq(billPayments.accountId, args.accountId), eq(billPayments.billId, args.billId)));
  return Number(row?.count ?? 0);
}

export type BillPaymentEligibility =
  | { ok: true }
  | { ok: false; reason: 'voided' | 'settled_without_payments' };

// May a payment be recorded against this bill?
//
// 'open' — yes. This is the ordinary case, including the first deposit. Note
// there is no draft equivalent to refuse: a bill posts Dr <category> / Cr AP the
// moment it is created, so there is always a liability to pay down. That is the
// one place this is SIMPLER than the invoice side, where a draft has posted no
// receivable and the payment has nothing to relieve.
//
// 'voided' — no. The bill was cancelled and its open posting reversed.
//
// 'paid' — only if it got there THROUGH payment rows. This is the guard that
// makes the change safe against live data: a bill settled by the old single-shot
// mark-paid carries header stamps and no rows, and its cash has already left the
// books. Accepting a payment against it would pay the vendor twice. A bill paid
// through rows, by contrast, must stay open to a refund or a correction —
// otherwise the only way to fix a mistake would be to void a legitimately paid
// bill, which the void guard now refuses anyway.
export function checkBillPaymentEligibility(args: {
  status: string;
  existingPaymentCount: number;
}): BillPaymentEligibility {
  if (args.status === 'voided') return { ok: false, reason: 'voided' };
  if (args.status === 'paid' && args.existingPaymentCount === 0) {
    return { ok: false, reason: 'settled_without_payments' };
  }
  return { ok: true };
}

// Re-derives settlement from the payment rows and writes the bill header to
// agree with it. Called after every payment insert and delete — it is the ONLY
// place bills.status moves as a result of money leaving, so the column and the
// rows cannot disagree.
//
// The legacy header columns are maintained rather than abandoned. paid_at,
// payment_method, payment_reference and payment_account_id are read by the AP
// aging report, both clients and the bill detail screens, and having them keep
// saying what they always said is what makes this change additive. They now
// mirror the MOST RECENT payment: for the single-payment case — still the common
// one — that is byte-identical to what mark-paid used to write.
//
// No explicit search reindex here, unlike syncInvoiceSettlement. That function
// covers four call sites, one of which (the Stripe webhook) writes no audit
// event, so the audit-driven reindex could not see it. Both callers of this one
// audit the bill they just changed, so the reindex already fires (TMC-206).
//
// Returns the updated bill, or null if it vanished (concurrent void/delete).
export async function syncBillSettlement(
  tx: Database | Transaction,
  args: { accountId: string; billId: string; amountCents: number },
): Promise<{ bill: Bill; summary: BillSettlementSummary } | null> {
  const paidCents = await paidCentsForBill(tx, {
    accountId: args.accountId,
    billId: args.billId,
  });
  const summary = summarizeBillSettlement({ amountCents: args.amountCents, paidCents });

  // The payment whose details the header mirrors: latest by the date the money
  // left, then by id so a same-day pair is still deterministic (uuidv7 is
  // time-ordered, so the tiebreak is insertion order).
  const [latest] = await tx
    .select()
    .from(billPayments)
    .where(and(eq(billPayments.accountId, args.accountId), eq(billPayments.billId, args.billId)))
    .orderBy(desc(billPayments.paidOn), desc(billPayments.id))
    .limit(1);

  const settled = summary.status === 'paid';
  const [updated] = await tx
    .update(bills)
    .set({
      status: summary.status,
      updatedAt: new Date(),
      // Cleared when the bill falls back to open — a refund that reopens a bill
      // must not leave a paid_at behind claiming it was settled.
      paidAt: settled && latest ? new Date(`${latest.paidOn}T00:00:00.000Z`) : null,
      paymentMethod: settled && latest ? latest.method : null,
      paymentReference: settled && latest ? latest.reference : null,
      paymentAccountId: settled && latest ? latest.paymentAccountId : null,
    })
    .where(and(eq(bills.id, args.billId), eq(bills.accountId, args.accountId)))
    .returning();

  return updated ? { bill: updated, summary } : null;
}
