import {
  type Database,
  type Invoice,
  type Transaction,
  chartOfAccounts,
  invoiceLineItems,
  journalEntries,
  journalLines,
} from '@thalermark/db';
import { and, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

// Hidden double-entry posting helper. Called from the invoice state machine
// (mark-sent / mark-paid / void) inside the existing tenant tx, and from the
// Stripe webhook on bootstrapDb inside an explicit tx so the deferred
// sum-to-zero trigger on journal_lines fires at commit and sees a balanced
// entry. Per [[project_ledger_decision]]: ledger is a hidden data-model
// commitment — no user-facing surface, just a balanced GL underneath every
// financial state change.
//
// Per JIT-scaffolding, this lives inline at apps/api/src/lib/ rather than
// in packages/ledger/. Promote to its own package only when a second
// consumer (mobile, GL export, expenses) appears.

// COA codes the posting helper targets. Hardcoded against SOLE_PROP_COA in
// packages/db/src/seed/coa-sole-prop.ts — if the seed renumbers, this map
// has to follow. Revenue is split by line type: the product-line subtotal
// credits Product Revenue (4100), the rest credits Service Revenue (4000).
// The split is derived at posting from the invoice's line items (see
// productSubtotalForInvoice) — there is no header column for it, so the entry
// always balances against the client-sent subtotal/total. Sales Tax Payable
// (2200) is only touched when the invoice carries tax > 0.
const COA_CASH = '1000';
// Exported for the position dashboard (slice 8.10): "money in/out" sums cash
// movement across asset accounts *except* AR, and "owed" is the AR balance.
export const COA_AR = '1200';
// Accounts Payable — the credit-normal liability bills post against. "owing" on
// the position dashboard is the AP balance, the mirror of "owed" (AR).
export const COA_AP = '2000';
const COA_SALES_TAX_PAYABLE = '2200';
const COA_SERVICE_REVENUE = '4000';
const COA_PRODUCT_REVENUE = '4100';

// Exact 2-dp decimal subtraction over the cents domain — avoids the FP drift
// of Number arithmetic on money strings. Both inputs are numeric(15,2), so
// Math.round mops up the *100 representation error. Used to derive the service
// revenue leg as subtotal − productSubtotal.
function subtractMoney(a: string, b: string): string {
  const cents = Math.round(Number(a) * 100) - Math.round(Number(b) * 100);
  return (cents / 100).toFixed(2);
}

export type LedgerSide = 'debit' | 'credit';

export type LedgerLine = {
  code: string;
  side: LedgerSide;
  amount: string; // decimal string
};

export type InvoiceStatusForPosting = 'draft' | 'sent' | 'paid' | 'voided';

// Pure function — given (prevStatus, nextStatus) and the invoice amounts,
// returns the list of journal lines to post. Empty array means "no
// posting" (e.g. draft → voided where nothing was previously booked).
//
// Revenue is split by line type: productSubtotal credits Product Revenue
// (4100) and serviceSubtotal = subtotal − productSubtotal credits Service
// Revenue (4000). serviceSubtotal + productSubtotal == subtotal by
// construction, so total = subtotal + tax still balances Dr AR/Cash.
//
// Posting matrix:
//   draft  → sent    Dr AR=total, Cr SvcRev, Cr ProdRev, Cr Tax (if>0)
//   draft  → paid    Dr Cash=total, Cr SvcRev, Cr ProdRev, Cr Tax (if>0)
//   sent   → paid    Dr Cash=total, Cr AR=total (no revenue movement)
//   sent   → voided  Dr SvcRev, Dr ProdRev, Dr Tax (if>0), Cr AR=total
//   draft  → voided  (nothing — no prior posting to reverse)
//
// Lines with amount=0 are dropped by postJournalEntry, so an all-service,
// tax=0 invoice emits a 2-line entry (service revenue, AR) without the empty
// product-revenue or tax lines.
export function invoicePostingLines(
  prevStatus: InvoiceStatusForPosting,
  nextStatus: InvoiceStatusForPosting,
  amounts: { subtotal: string; productSubtotal: string; tax: string; total: string },
): LedgerLine[] {
  const { subtotal, productSubtotal, tax, total } = amounts;
  const serviceSubtotal = subtractMoney(subtotal, productSubtotal);

  if (prevStatus === 'draft' && nextStatus === 'sent') {
    return [
      { code: COA_AR, side: 'debit', amount: total },
      { code: COA_SERVICE_REVENUE, side: 'credit', amount: serviceSubtotal },
      { code: COA_PRODUCT_REVENUE, side: 'credit', amount: productSubtotal },
      { code: COA_SALES_TAX_PAYABLE, side: 'credit', amount: tax },
    ];
  }
  if (prevStatus === 'draft' && nextStatus === 'paid') {
    return [
      { code: COA_CASH, side: 'debit', amount: total },
      { code: COA_SERVICE_REVENUE, side: 'credit', amount: serviceSubtotal },
      { code: COA_PRODUCT_REVENUE, side: 'credit', amount: productSubtotal },
      { code: COA_SALES_TAX_PAYABLE, side: 'credit', amount: tax },
    ];
  }
  if (prevStatus === 'sent' && nextStatus === 'paid') {
    return [
      { code: COA_CASH, side: 'debit', amount: total },
      { code: COA_AR, side: 'credit', amount: total },
    ];
  }
  if (prevStatus === 'sent' && nextStatus === 'voided') {
    return [
      { code: COA_SERVICE_REVENUE, side: 'debit', amount: serviceSubtotal },
      { code: COA_PRODUCT_REVENUE, side: 'debit', amount: productSubtotal },
      { code: COA_SALES_TAX_PAYABLE, side: 'debit', amount: tax },
      { code: COA_AR, side: 'credit', amount: total },
    ];
  }
  return [];
}

// Sums the product-typed line-item amounts for an invoice — the revenue split
// input for postInvoiceTransition / repostInvoicePaymentDate. Derived from the
// persisted lines (which carry the type snapshot) rather than a header column,
// so it always agrees with what was billed. Filters by accountId too: the
// webhook posting path runs without RLS, and it keeps the lookup on-index.
async function productSubtotalForInvoice(
  tx: Database | Transaction,
  args: { accountId: string; invoiceId: string },
): Promise<string> {
  const [row] = await tx
    .select({
      productSubtotal: sql<string>`coalesce(sum(${invoiceLineItems.amount}), 0)::numeric(15,2)`,
    })
    .from(invoiceLineItems)
    .where(
      and(
        eq(invoiceLineItems.accountId, args.accountId),
        eq(invoiceLineItems.invoiceId, args.invoiceId),
        eq(invoiceLineItems.type, 'product'),
      ),
    );
  return row?.productSubtotal ?? '0.00';
}

// Inserts one journal_entries header + N journal_lines rows. Filters out
// any line with amount ≤ 0 so callers can hand in a fixed-shape list and
// not worry about empty-tax / empty-revenue degenerates. Returns null
// silently if fewer than two non-zero lines remain (the min-2 invariant
// enforced by the deferred trigger would otherwise abort the tx at
// commit, killing the surrounding state transition).
//
// Throws if any required COA account is missing for the company — that's
// a hard inconsistency (signup hook seeds the full COA in the same tx as
// account + company + membership; only path to a missing account is a
// dev DB created before L1 landed) and silently skipping would let the
// ledger drift out of sync with the operational side.
export async function postJournalEntry(
  tx: Database | Transaction,
  spec: {
    accountId: string;
    companyId: string;
    sourceEntityType: string;
    sourceEntityId: string;
    postedAt: Date;
    memo: string;
    lines: LedgerLine[];
  },
): Promise<string | null> {
  const lines = spec.lines.filter((l) => Number(l.amount) > 0);
  if (lines.length < 2) return null;

  const codes = Array.from(new Set(lines.map((l) => l.code)));
  const coa = await tx
    .select({ id: chartOfAccounts.id, code: chartOfAccounts.code })
    .from(chartOfAccounts)
    .where(
      and(eq(chartOfAccounts.companyId, spec.companyId), inArray(chartOfAccounts.code, codes)),
    );
  const byCode = new Map(coa.map((r) => [r.code, r.id]));
  for (const code of codes) {
    if (!byCode.has(code)) {
      throw new Error(
        `ledger: COA account ${code} missing for company ${spec.companyId} — seed integrity broken`,
      );
    }
  }

  const entryId = uuidv7();
  await tx.insert(journalEntries).values({
    id: entryId,
    accountId: spec.accountId,
    companyId: spec.companyId,
    sourceEntityType: spec.sourceEntityType,
    sourceEntityId: spec.sourceEntityId,
    postedAt: spec.postedAt,
    memo: spec.memo,
  });
  await tx.insert(journalLines).values(
    lines.map((l) => ({
      id: uuidv7(),
      accountId: spec.accountId,
      journalEntryId: entryId,
      coaAccountId: byCode.get(l.code) as string,
      side: l.side,
      amount: l.amount,
    })),
  );
  return entryId;
}

// Expense posting policy. Cash-method MVP: every expense create posts
//   Dr <category>   amount
//   Cr <payment>    amount
// where category is one of the 6000–7950 expense accounts and payment is
// an asset account (defaults to Cash 1000). Edit = full reversal + new
// posting in one tx; delete = reversal only. Reversal is just the create
// lines with sides flipped — see reverseLedgerLines below.
//
// Codes are passed in (not constants like the invoice helper) because the
// category + payment account are user-pickable per expense. The API layer
// resolves the FK uuids to codes once, validates account_type, and hands
// the codes through.
export function expensePostingLines(args: {
  categoryCode: string;
  paymentCode: string;
  amount: string;
}): LedgerLine[] {
  return [
    { code: args.categoryCode, side: 'debit', amount: args.amount },
    { code: args.paymentCode, side: 'credit', amount: args.amount },
  ];
}

// Pure: returns a new list with each side flipped (debit ↔ credit), codes
// and amounts preserved. Sum-to-zero is preserved by symmetry. Used by the
// expense reversal wrapper but lives generic — any future reversal (refund
// on payment, void on expense, etc.) can reuse it.
export function reverseLedgerLines(lines: LedgerLine[]): LedgerLine[] {
  return lines.map((l) => ({
    code: l.code,
    side: l.side === 'debit' ? 'credit' : 'debit',
    amount: l.amount,
  }));
}

// Thin wrapper: derives lines from the expense + codes and posts. Caller
// is inside the tenant tx (8.9c API mutation wraps row write + audit +
// posting in one tx so the deferred sum-to-zero trigger fires at commit).
export async function postExpenseCreate(
  tx: Database | Transaction,
  args: {
    expense: { id: string; merchant: string; amount: string };
    categoryCode: string;
    paymentCode: string;
    accountId: string;
    companyId: string;
    postedAt: Date;
  },
): Promise<string | null> {
  const lines = expensePostingLines({
    categoryCode: args.categoryCode,
    paymentCode: args.paymentCode,
    amount: args.expense.amount,
  });
  return postJournalEntry(tx, {
    accountId: args.accountId,
    companyId: args.companyId,
    sourceEntityType: 'expense',
    sourceEntityId: args.expense.id,
    postedAt: args.postedAt,
    memo: `Expense ${args.expense.merchant}`,
    lines,
  });
}

// Posts the reversal of an expense's prior create entry. Caller passes the
// codes + amount that were posted originally (the API edit path captures
// pre-mutation row values for the reversal, then calls postExpenseCreate
// with the new values; the delete path just reverses).
export async function postExpenseReversal(
  tx: Database | Transaction,
  args: {
    expense: { id: string; merchant: string; amount: string };
    categoryCode: string;
    paymentCode: string;
    accountId: string;
    companyId: string;
    postedAt: Date;
  },
): Promise<string | null> {
  const original = expensePostingLines({
    categoryCode: args.categoryCode,
    paymentCode: args.paymentCode,
    amount: args.expense.amount,
  });
  const lines = reverseLedgerLines(original);
  return postJournalEntry(tx, {
    accountId: args.accountId,
    companyId: args.companyId,
    sourceEntityType: 'expense',
    sourceEntityId: args.expense.id,
    postedAt: args.postedAt,
    memo: `Expense ${args.expense.merchant} reversal`,
    lines,
  });
}

// --- Bill (accounts payable) posting -------------------------------------
// A bill is the accrual mirror of an expense. Recording it ("open") recognises
// the cost and the liability:
//   Dr <category>   amount
//   Cr Accounts Payable   amount
// Settling it ("paid") clears the liability against an asset:
//   Dr Accounts Payable   amount
//   Cr <payment asset>    amount
// Edit while open = reverse the open posting + repost (like expenses); void
// while open = reverse the open posting only. Codes are passed in because the
// category (and the payment asset, on settle) are user-pickable per bill.

export function billOpenLines(args: { categoryCode: string; amount: string }): LedgerLine[] {
  return [
    { code: args.categoryCode, side: 'debit', amount: args.amount },
    { code: COA_AP, side: 'credit', amount: args.amount },
  ];
}

export function billPaymentLines(args: { paymentCode: string; amount: string }): LedgerLine[] {
  return [
    { code: COA_AP, side: 'debit', amount: args.amount },
    { code: args.paymentCode, side: 'credit', amount: args.amount },
  ];
}

// Posts the open (Dr category / Cr AP) entry for a newly recorded bill. `label`
// is a human-readable handle for the GL memo (vendor name, optionally + the
// vendor's reference). Caller is inside the tenant tx.
export async function postBillOpen(
  tx: Database | Transaction,
  args: {
    bill: { id: string; amount: string; label: string };
    categoryCode: string;
    accountId: string;
    companyId: string;
    postedAt: Date;
  },
): Promise<string | null> {
  return postJournalEntry(tx, {
    accountId: args.accountId,
    companyId: args.companyId,
    sourceEntityType: 'bill',
    sourceEntityId: args.bill.id,
    postedAt: args.postedAt,
    memo: `Bill ${args.bill.label} open`,
    lines: billOpenLines({ categoryCode: args.categoryCode, amount: args.bill.amount }),
  });
}

// Reverses a bill's open posting — used by edit (before reposting the new
// amounts) and void. Just the open lines with sides flipped.
export async function postBillOpenReversal(
  tx: Database | Transaction,
  args: {
    bill: { id: string; amount: string; label: string };
    categoryCode: string;
    accountId: string;
    companyId: string;
    postedAt: Date;
  },
): Promise<string | null> {
  const lines = reverseLedgerLines(
    billOpenLines({ categoryCode: args.categoryCode, amount: args.bill.amount }),
  );
  return postJournalEntry(tx, {
    accountId: args.accountId,
    companyId: args.companyId,
    sourceEntityType: 'bill',
    sourceEntityId: args.bill.id,
    postedAt: args.postedAt,
    memo: `Bill ${args.bill.label} reversal`,
    lines,
  });
}

// Posts the settlement (Dr AP / Cr payment asset) for a bill being marked paid.
export async function postBillPayment(
  tx: Database | Transaction,
  args: {
    bill: { id: string; amount: string; label: string };
    paymentCode: string;
    accountId: string;
    companyId: string;
    postedAt: Date;
  },
): Promise<string | null> {
  return postJournalEntry(tx, {
    accountId: args.accountId,
    companyId: args.companyId,
    sourceEntityType: 'bill',
    sourceEntityId: args.bill.id,
    postedAt: args.postedAt,
    memo: `Bill ${args.bill.label} paid`,
    lines: billPaymentLines({ paymentCode: args.paymentCode, amount: args.bill.amount }),
  });
}

// Thin wrapper: derives lines from the invoice + transition and posts.
// Caller is responsible for being inside a tx (tenant tx for mark-* on
// transitionInvoice, explicit bootstrap tx for the Stripe webhook path)
// — the deferred sum-to-zero trigger requires it.
export async function postInvoiceTransition(
  tx: Database | Transaction,
  args: {
    invoice: Pick<Invoice, 'id' | 'number' | 'subtotal' | 'tax' | 'total'>;
    prevStatus: InvoiceStatusForPosting;
    nextStatus: InvoiceStatusForPosting;
    accountId: string;
    companyId: string;
    postedAt: Date;
  },
): Promise<string | null> {
  const productSubtotal = await productSubtotalForInvoice(tx, {
    accountId: args.accountId,
    invoiceId: args.invoice.id,
  });
  const lines = invoicePostingLines(args.prevStatus, args.nextStatus, {
    subtotal: args.invoice.subtotal,
    productSubtotal,
    tax: args.invoice.tax,
    total: args.invoice.total,
  });
  if (lines.length === 0) return null;
  return postJournalEntry(tx, {
    accountId: args.accountId,
    companyId: args.companyId,
    sourceEntityType: 'invoice',
    sourceEntityId: args.invoice.id,
    postedAt: args.postedAt,
    memo: `Invoice ${args.invoice.number} ${args.nextStatus}`,
    lines,
  });
}

// Moves an invoice's *payment* posting from one date to another by reversing
// the original paid entry at its original date (so that period nets to zero)
// and re-posting it at the new date. Only the paid posting moves — the
// draft→sent issue/AR posting (if any) is untouched. The ledger is append-only
// (migration 0026), so this is the only correct way to "edit" a payment date;
// cashFlowNet already nets reversals by source_entity_id so reporting stays
// right. prevStatus picks which paid posting was made: sent→paid (Dr Cash /
// Cr AR) vs draft→paid (Dr Cash / Cr Rev / Tax) — derive it from whether the
// invoice was ever sent.
export async function repostInvoicePaymentDate(
  tx: Database | Transaction,
  args: {
    invoice: Pick<Invoice, 'id' | 'number' | 'subtotal' | 'tax' | 'total'>;
    prevStatus: 'draft' | 'sent';
    accountId: string;
    companyId: string;
    fromDate: Date;
    toDate: Date;
  },
): Promise<void> {
  const productSubtotal = await productSubtotalForInvoice(tx, {
    accountId: args.accountId,
    invoiceId: args.invoice.id,
  });
  const original = invoicePostingLines(args.prevStatus, 'paid', {
    subtotal: args.invoice.subtotal,
    productSubtotal,
    tax: args.invoice.tax,
    total: args.invoice.total,
  });
  if (original.length === 0) return;
  const base = {
    accountId: args.accountId,
    companyId: args.companyId,
    sourceEntityType: 'invoice',
    sourceEntityId: args.invoice.id,
  };
  await postJournalEntry(tx, {
    ...base,
    postedAt: args.fromDate,
    memo: `Invoice ${args.invoice.number} paid reversal (date corrected)`,
    lines: reverseLedgerLines(original),
  });
  await postJournalEntry(tx, {
    ...base,
    postedAt: args.toDate,
    memo: `Invoice ${args.invoice.number} paid (date corrected)`,
    lines: original,
  });
}

// --- Ledger read helpers (position dashboard + cash-flow nudges) -----------
// "cash" = asset accounts other than AR; "owed" = the AR balance.

type LedgerScope = { accountId: string; companyId: string };

// Reversal-safe cash flow over a half-open window [fromDate, toExclusive).
// Nets signed cash movement per source_entity_id BEFORE splitting by direction:
// the ledger is immutable, so editing/voiding an expense posts a reversing
// entry whose "Dr Cash" would otherwise read as money in and double the gross
// out. A create+edit collapses to the latest amount, a create+delete to zero
// (the dashboard reversal fix, #144). Returns 2-dp decimal strings.
export async function cashFlowNet(
  tx: Database | Transaction,
  scope: LedgerScope & { fromDate: Date; toExclusive: Date },
): Promise<{ moneyIn: string; moneyOut: string }> {
  const bySource = tx
    .select({
      netDebit:
        sql<string>`sum(case when ${journalLines.side} = 'debit' then ${journalLines.amount} else -${journalLines.amount} end)`.as(
          'net_debit',
        ),
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
    .where(
      and(
        eq(journalEntries.companyId, scope.companyId),
        eq(journalEntries.accountId, scope.accountId),
        eq(chartOfAccounts.accountType, 'asset'),
        ne(chartOfAccounts.code, COA_AR),
        gte(journalEntries.postedAt, scope.fromDate),
        lt(journalEntries.postedAt, scope.toExclusive),
      ),
    )
    .groupBy(journalEntries.sourceEntityId)
    .as('cash_by_source');
  const [row] = await tx
    .select({
      moneyIn: sql<string>`coalesce(sum(${bySource.netDebit}) filter (where ${bySource.netDebit} > 0), 0)::numeric(15,2)`,
      moneyOut: sql<string>`coalesce(-sum(${bySource.netDebit}) filter (where ${bySource.netDebit} < 0), 0)::numeric(15,2)`,
    })
    .from(bySource);
  return { moneyIn: row?.moneyIn ?? '0.00', moneyOut: row?.moneyOut ?? '0.00' };
}

// Cash on hand: signed balance (debits − credits) across asset accounts other
// than AR, all-time. A point-in-time balance is reversal-safe by construction
// (reversal pairs cancel), so no per-source netting is needed here.
export async function cashOnHand(tx: Database | Transaction, scope: LedgerScope): Promise<string> {
  const [row] = await tx
    .select({
      balance: sql<string>`coalesce(sum(case when ${journalLines.side} = 'debit' then ${journalLines.amount} else -${journalLines.amount} end), 0)::numeric(15,2)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
    .where(
      and(
        eq(journalEntries.companyId, scope.companyId),
        eq(journalEntries.accountId, scope.accountId),
        eq(chartOfAccounts.accountType, 'asset'),
        ne(chartOfAccounts.code, COA_AR),
      ),
    );
  return row?.balance ?? '0.00';
}

// Owed: live AR balance (debits − credits on the AR account), all-time — what
// customers currently owe. A point-in-time figure, not a period flow.
export async function arBalance(tx: Database | Transaction, scope: LedgerScope): Promise<string> {
  const [row] = await tx
    .select({
      owed: sql<string>`coalesce(sum(case when ${journalLines.side} = 'debit' then ${journalLines.amount} else -${journalLines.amount} end), 0)::numeric(15,2)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
    .where(
      and(
        eq(journalEntries.companyId, scope.companyId),
        eq(journalEntries.accountId, scope.accountId),
        eq(chartOfAccounts.code, COA_AR),
      ),
    );
  return row?.owed ?? '0.00';
}

// Owing: live AP balance — what the business currently owes vendors. AP is
// credit-normal, so the outstanding balance is credits − debits (an open bill
// credits AP; paying or voiding it debits AP back down). Point-in-time figure,
// reversal-safe by construction, the mirror of arBalance.
export async function apBalance(tx: Database | Transaction, scope: LedgerScope): Promise<string> {
  const [row] = await tx
    .select({
      owing: sql<string>`coalesce(sum(case when ${journalLines.side} = 'credit' then ${journalLines.amount} else -${journalLines.amount} end), 0)::numeric(15,2)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
    .where(
      and(
        eq(journalEntries.companyId, scope.companyId),
        eq(journalEntries.accountId, scope.accountId),
        eq(chartOfAccounts.code, COA_AP),
      ),
    );
  return row?.owing ?? '0.00';
}
