import {
  type Database,
  type Invoice,
  type Transaction,
  chartOfAccounts,
  invoiceLineItems,
  journalEntries,
  journalLines,
} from '@thalermark/db';
import type { DepreciationConvention } from '@thalermark/validation';
import type { SQL } from 'drizzle-orm';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { type PostingIntent, assertCompanyActive } from './company-lock.js';
import { assertPeriodOpen } from './period-lock.js';

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
// Owner's Equity (credit-normal) + Owner's Draw (debit-normal). Owner money
// events are the only thing that posts to these — a contribution credits
// equity, a draw debits the draw account. Seeded into every company's COA from
// the start (see SOLE_PROP_COA) but untouched until this entity landed.
const COA_OWNERS_EQUITY = '3000';
const COA_OWNERS_DRAW = '3100';
const COA_SERVICE_REVENUE = '4000';
const COA_PRODUCT_REVENUE = '4100';
// Capital purchases ("big purchases"). Equipment (1500, debit-normal asset) is
// the gross cost of durable gear; Accumulated Depreciation (1900, a contra-asset
// seeded debit-normal — see SOLE_PROP_COA) nets it down. Loans Payable (2700,
// credit-normal liability) is what's still owed on financed purchases. The §179
// write-off + the spread-it-out path both post Depreciation Expense (6350);
// loan-payment interest posts Interest Expense (6500).
const COA_EQUIPMENT = '1500';
const COA_ACCUM_DEPRECIATION = '1900';
const COA_LOANS_PAYABLE = '2700';
const COA_DEPRECIATION_EXPENSE = '6350';
const COA_INTEREST_EXPENSE = '6500';
// Merchant Processing Fees (7950 → Schedule C line 27a). Stripe keeps its cut
// before depositing, so a card payment debits Cash for the *net* and this for
// the fee, against the customer's gross. Only the Stripe webhook supplies a
// fee; every manual mark-paid channel leaves it null and posts Cash at gross.
const COA_MERCHANT_FEES = '7950';

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
// processingFee (TMC-156) is the processor's cut on a card payment. Stripe
// deposits net, so on the two → paid transitions the customer's gross splits
// across Dr Cash = total − fee and Dr Merchant Processing Fees = fee. The
// credit side is untouched: the customer really did pay `total`, and Schedule C
// gross receipts must stay gross to match the 1099-K Stripe files. Null/absent
// (every manual mark-paid channel) collapses to the original two-line shape
// because the fee line is 0 and postJournalEntry drops it.
//
// Posting matrix:
//   draft  → sent    Dr AR=total, Cr SvcRev, Cr ProdRev, Cr Tax (if>0)
//   draft  → paid    Dr Cash=total−fee, Dr Fees (if>0), Cr SvcRev, Cr ProdRev, Cr Tax (if>0)
//   sent   → paid    Dr Cash=total−fee, Dr Fees (if>0), Cr AR=total (no revenue movement)
//   sent   → voided  Dr SvcRev, Dr ProdRev, Dr Tax (if>0), Cr AR=total
//   draft  → voided  (nothing — no prior posting to reverse)
//
// Lines with amount=0 are dropped by postJournalEntry, so an all-service,
// tax=0 invoice emits a 2-line entry (service revenue, AR) without the empty
// product-revenue or tax lines.
export function invoicePostingLines(
  prevStatus: InvoiceStatusForPosting,
  nextStatus: InvoiceStatusForPosting,
  amounts: {
    subtotal: string;
    productSubtotal: string;
    tax: string;
    total: string;
    processingFee?: string | null;
  },
): LedgerLine[] {
  const { subtotal, productSubtotal, tax, total, processingFee } = amounts;
  const serviceSubtotal = subtractMoney(subtotal, productSubtotal);
  const fee = processingFee ?? '0.00';
  const cashNet = subtractMoney(total, fee);

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
      { code: COA_CASH, side: 'debit', amount: cashNet },
      { code: COA_MERCHANT_FEES, side: 'debit', amount: fee },
      { code: COA_SERVICE_REVENUE, side: 'credit', amount: serviceSubtotal },
      { code: COA_PRODUCT_REVENUE, side: 'credit', amount: productSubtotal },
      { code: COA_SALES_TAX_PAYABLE, side: 'credit', amount: tax },
    ];
  }
  if (prevStatus === 'sent' && nextStatus === 'paid') {
    return [
      { code: COA_CASH, side: 'debit', amount: cashNet },
      { code: COA_MERCHANT_FEES, side: 'debit', amount: fee },
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
    // Whether this is new business or the settlement of an existing obligation.
    // Only consulted by the retirement lock; omitted means 'origination', which
    // is the safe default (see company-lock.ts).
    intent?: PostingIntent;
  },
): Promise<string | null> {
  const lines = spec.lines.filter((l) => Number(l.amount) > 0);
  if (lines.length < 2) return null;

  // The period lock (TMC-159). Checked here rather than in each route because
  // this is the funnel every code-keyed posting flows through — invoice
  // transitions, expenses, bills, owner money, opening balances, capital
  // purchases, loan payments, the depreciation sweep and the Stripe webhook all
  // land on it. Throws PeriodClosedError, which app.ts maps to a 409.
  await assertPeriodOpen(tx, {
    accountId: spec.accountId,
    companyId: spec.companyId,
    postedAt: spec.postedAt,
  });
  // The retirement lock, on the same funnel. Where the period lock bars a DATE
  // range, this bars new business outright — but still lets a retired company
  // settle what it was already owed or already owed others. `intent` defaults to
  // 'origination', so a posting helper added later is refused by default.
  await assertCompanyActive(tx, {
    accountId: spec.accountId,
    companyId: spec.companyId,
    intent: spec.intent,
  });

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
    // Paying a bill the business had already opened is settlement — a retired
    // company still has to be able to pay what it owed (see company-lock.ts).
    intent: 'settlement',
  });
}

// --- Owner money event posting --------------------------------------------
// The owner moving their own money in or out — the only path that posts to
// Owner's Equity (3000) / Owner's Draw (3100). `kind` fully determines the two
// balanced lines; there is no category or payment-account choice (cash is
// always Cash 1000, the single-Cash MVP assumption):
//   contribution → Dr Cash / Cr Owner's Equity
//   draw         → Dr Owner's Draw / Cr Cash
// Edit = reverse the prior entry + repost (like expenses); delete (soft) =
// reverse only. Reversal reuses reverseLedgerLines.

export type OwnerMoneyEventKind = 'contribution' | 'draw';

export function ownerMoneyEventLines(kind: OwnerMoneyEventKind, amount: string): LedgerLine[] {
  if (kind === 'contribution') {
    return [
      { code: COA_CASH, side: 'debit', amount },
      { code: COA_OWNERS_EQUITY, side: 'credit', amount },
    ];
  }
  return [
    { code: COA_OWNERS_DRAW, side: 'debit', amount },
    { code: COA_CASH, side: 'credit', amount },
  ];
}

// Posts the entry for a newly recorded owner money event. Caller is inside the
// tenant tx so the deferred sum-to-zero trigger fires at commit.
export async function postOwnerMoneyEvent(
  tx: Database | Transaction,
  args: {
    event: { id: string; kind: OwnerMoneyEventKind; amount: string };
    accountId: string;
    companyId: string;
    postedAt: Date;
  },
): Promise<string | null> {
  return postJournalEntry(tx, {
    accountId: args.accountId,
    companyId: args.companyId,
    sourceEntityType: 'owner_money_event',
    sourceEntityId: args.event.id,
    postedAt: args.postedAt,
    memo: args.event.kind === 'contribution' ? 'Owner contribution' : 'Owner draw',
    lines: ownerMoneyEventLines(args.event.kind, args.event.amount),
  });
}

// Reverses an owner money event's prior entry — used by edit (before reposting
// the new values) and soft-delete. Just the original lines with sides flipped.
export async function postOwnerMoneyEventReversal(
  tx: Database | Transaction,
  args: {
    event: { id: string; kind: OwnerMoneyEventKind; amount: string };
    accountId: string;
    companyId: string;
    postedAt: Date;
  },
): Promise<string | null> {
  const lines = reverseLedgerLines(ownerMoneyEventLines(args.event.kind, args.event.amount));
  return postJournalEntry(tx, {
    accountId: args.accountId,
    companyId: args.companyId,
    sourceEntityType: 'owner_money_event',
    sourceEntityId: args.event.id,
    postedAt: args.postedAt,
    memo:
      args.event.kind === 'contribution' ? 'Owner contribution reversal' : 'Owner draw reversal',
    lines,
  });
}

// --- Opening balances ------------------------------------------------------
// Where the books start. Two ways in, one way through.
//
// The SIMPLE shape asks three plain questions in "My Money" — what was in the
// bank, who owed you, who did you owe — and expands them here into the four
// lines they always implied, with Owner's Equity (3000) as the sign-aware plug:
//   Dr Cash 1000            = cash
//   Dr Accounts Receivable  = receivables
//   Cr Accounts Payable     = payables
//   Owner's Equity 3000     = cash + receivables − payables (Cr if +, Dr if −)
// Zero legs are dropped, so a cash-only start posts the 2-line Dr Cash / Cr
// Owner's Equity — the same shape as an owner contribution.
//
// The FULL shape is an opening trial balance entered account by account, for a
// business arriving with real books: a part-depreciated mower, an outstanding
// loan, sales tax already collected, a corporation's capital-stock split. None
// of that fits three numbers.
//
// Both are stored as opening_balance_lines and posted from there, so the ledger
// has exactly one entry path. Edit = reverse + repost; clear = soft-delete +
// reverse.
export function simpleOpeningBalanceLines(args: {
  cash: string;
  receivables: string;
  payables: string;
}): LedgerLine[] {
  const cents = (s: string) => Math.round(Number(s) * 100);
  const equityCents = cents(args.cash) + cents(args.receivables) - cents(args.payables);
  const fromCents = (c: number) => (Math.abs(c) / 100).toFixed(2);
  const lines: LedgerLine[] = [
    { code: COA_CASH, side: 'debit', amount: args.cash },
    { code: COA_AR, side: 'debit', amount: args.receivables },
    { code: COA_AP, side: 'credit', amount: args.payables },
    equityCents >= 0
      ? { code: COA_OWNERS_EQUITY, side: 'credit', amount: fromCents(equityCents) }
      : { code: COA_OWNERS_EQUITY, side: 'debit', amount: fromCents(equityCents) },
  ];
  // Zero legs are dropped here rather than by the posting helper, because these
  // lines are now STORED before they're posted — a persisted 0.00 row would be a
  // line claiming an account opened at nothing.
  return lines.filter((l) => Number(l.amount) > 0);
}

// Post a stored opening balance from its lines.
//
// Account-id-keyed, so it writes through insertEntryWithAccountIds rather than
// postJournalEntry — which means the two locks that helper deliberately skips
// have to be asserted here explicitly. They are: an opening balance is ordinary
// business, not a close or a handover, so it must respect both a closed period
// and a retired company.
type OpeningBalancePosting = {
  openingBalanceId: string;
  lines: ManualJournalLine[];
  accountId: string;
  companyId: string;
  postedAt: Date;
};

async function postOpeningBalanceEntry(
  tx: Database | Transaction,
  args: OpeningBalancePosting & { memo: string },
): Promise<string | null> {
  if (args.lines.length < 2) return null;
  await assertPeriodOpen(tx, {
    accountId: args.accountId,
    companyId: args.companyId,
    postedAt: args.postedAt,
  });
  await assertCompanyActive(tx, { accountId: args.accountId, companyId: args.companyId });

  const entryId = uuidv7();
  await insertEntryWithAccountIds(tx, {
    entryId,
    accountId: args.accountId,
    companyId: args.companyId,
    sourceEntityType: 'opening_balance',
    // The opening-balance row, NOT the entry — so the original and every later
    // reversal share one source group and cashFlowNet's per-source netting
    // cancels an edited starting position for free.
    sourceEntityId: args.openingBalanceId,
    postedAt: args.postedAt,
    memo: args.memo,
    lines: args.lines,
  });
  return entryId;
}

export function postOpeningBalance(
  tx: Database | Transaction,
  args: OpeningBalancePosting,
): Promise<string | null> {
  return postOpeningBalanceEntry(tx, { ...args, memo: 'Opening balances' });
}

// The same lines with each side flipped, dated at the posting being undone.
// Callers pass the lines that were originally stored, so an edit reverses what
// was actually posted rather than what is about to be.
export function postOpeningBalanceReversal(
  tx: Database | Transaction,
  args: OpeningBalancePosting,
): Promise<string | null> {
  return postOpeningBalanceEntry(tx, {
    ...args,
    lines: flipManualLines(args.lines),
    memo: 'Opening balances reversal',
  });
}

// --- Capital purchases ("big purchases": equipment + financing) ------------
// Durable gear the business buys and uses for years — a mower on payments. The
// honest accounting the MVP couldn't do: a capital asset (not an expense),
// optionally financed (a loan, not AP), and either written off this year (§179)
// or depreciated over its life. All hidden behind plain language.
//
// At purchase, capitalize the full cost and fund it:
//   Dr Equipment 1500        = amount (the whole cost goes on the books as an asset)
//   Cr Cash 1000             = paidNow (down payment, or the full price if not financed)
//   Cr Loans Payable 2700    = amount − paidNow (the financed remainder; 0 if paid in full)
// Plus, when the user picks "deduct it all this year" (§179):
//   Dr Depreciation Expense 6350 / Cr Accumulated Depreciation 1900 = amount
// so the asset's book value is zero (fully written off) while it stays on the
// books — real §179, not a hack that just expenses it. "Spread it out" omits
// that pair here; the yearly depreciation is the deferred follow-on.
//
// The loan leg carries source_entity_id = the purchase id, so the per-purchase
// balance is derived from the ledger (loanBalance below) — the bills/owner-money
// source-group pattern, no balance column. Edit = reverse + repost; delete
// (soft) = reverse, like the other ledger-aware entities.

export type CapitalPurchaseTaxTreatment = 'deduct_now' | 'spread';

export function capitalPurchaseLines(args: {
  amount: string;
  paidNow: string;
  taxTreatment: CapitalPurchaseTaxTreatment;
}): LedgerLine[] {
  const financed = subtractMoney(args.amount, args.paidNow);
  const lines: LedgerLine[] = [
    { code: COA_EQUIPMENT, side: 'debit', amount: args.amount },
    { code: COA_CASH, side: 'credit', amount: args.paidNow },
    { code: COA_LOANS_PAYABLE, side: 'credit', amount: financed },
  ];
  if (args.taxTreatment === 'deduct_now') {
    lines.push(
      { code: COA_DEPRECIATION_EXPENSE, side: 'debit', amount: args.amount },
      { code: COA_ACCUM_DEPRECIATION, side: 'credit', amount: args.amount },
    );
  }
  return lines;
}

export async function postCapitalPurchase(
  tx: Database | Transaction,
  args: {
    purchase: {
      id: string;
      amount: string;
      paidNow: string;
      taxTreatment: CapitalPurchaseTaxTreatment;
      description: string;
    };
    accountId: string;
    companyId: string;
    postedAt: Date;
  },
): Promise<string | null> {
  return postJournalEntry(tx, {
    accountId: args.accountId,
    companyId: args.companyId,
    sourceEntityType: 'capital_purchase',
    sourceEntityId: args.purchase.id,
    postedAt: args.postedAt,
    memo: `Purchase ${args.purchase.description}`,
    lines: capitalPurchaseLines(args.purchase),
  });
}

export async function postCapitalPurchaseReversal(
  tx: Database | Transaction,
  args: {
    purchase: {
      id: string;
      amount: string;
      paidNow: string;
      taxTreatment: CapitalPurchaseTaxTreatment;
      description: string;
    };
    accountId: string;
    companyId: string;
    postedAt: Date;
  },
): Promise<string | null> {
  return postJournalEntry(tx, {
    accountId: args.accountId,
    companyId: args.companyId,
    sourceEntityType: 'capital_purchase',
    sourceEntityId: args.purchase.id,
    postedAt: args.postedAt,
    memo: `Purchase ${args.purchase.description} reversal`,
    lines: reverseLedgerLines(capitalPurchaseLines(args.purchase)),
  });
}

// A payment toward a financed purchase: pay down the loan, split out any
// interest, from cash.
//   Dr Loans Payable 2700      = principal (amount − interest)
//   Dr Interest Expense 6500   = interest (0 if not split out)
//   Cr Cash 1000               = amount
// The loan leg is tagged with the purchase id (source group) so loanBalance
// nets it against the original financed credit.
export function loanPaymentLines(args: { amount: string; interest: string }): LedgerLine[] {
  const principal = subtractMoney(args.amount, args.interest);
  return [
    { code: COA_LOANS_PAYABLE, side: 'debit', amount: principal },
    { code: COA_INTEREST_EXPENSE, side: 'debit', amount: args.interest },
    { code: COA_CASH, side: 'credit', amount: args.amount },
  ];
}

export async function postLoanPayment(
  tx: Database | Transaction,
  args: {
    purchaseId: string;
    description: string;
    amount: string;
    interest: string;
    accountId: string;
    companyId: string;
    postedAt: Date;
  },
): Promise<string | null> {
  return postJournalEntry(tx, {
    accountId: args.accountId,
    companyId: args.companyId,
    sourceEntityType: 'capital_purchase',
    sourceEntityId: args.purchaseId,
    postedAt: args.postedAt,
    memo: `Payment toward ${args.description}`,
    lines: loanPaymentLines({ amount: args.amount, interest: args.interest }),
    // Paying down a loan the business already owed is settlement, not new
    // borrowing (see company-lock.ts).
    intent: 'settlement',
  });
}

// What's still owed on one financed purchase: the net credit balance on Loans
// Payable (2700) across the entries tagged with this purchase id (the original
// financed credit, less each payment's principal debit). Reversal-safe by
// construction (a reversed purchase nets to zero). Returns a 2-dp decimal string.
export async function loanBalance(
  tx: Database | Transaction,
  scope: LedgerScope & { purchaseId: string },
): Promise<string> {
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
        eq(journalEntries.sourceEntityId, scope.purchaseId),
        eq(chartOfAccounts.code, COA_LOANS_PAYABLE),
      ),
    );
  return row?.owing ?? '0.00';
}

// Pure: the "spread it out" plan — straight-line depreciation of `cost` over
// `lifeYears`, resolved to the actual calendar years it posts in. Powers both
// the surfaced plain answer ("about $360 this year, then about $720 a year")
// and the sweeper's posting schedule, so the number a user is shown and the
// number that reaches Schedule C line 13 can't drift apart.
//
// Straight-line, deliberately not MACRS. MACRS front-loads on a declining curve
// keyed to a property class, and asking a landscaper which class a mower is
// would be exactly the jargon this feature exists to avoid. Straight-line over
// a useful life is a legitimate, conservative method — and the worksheet is
// framed as awareness, not a filed return.
//
// The convention decides year one:
//   half_year — the IRS default: the asset counts as placed in service at
//               mid-year whatever month it was bought, so year one takes half a
//               chunk and the tail spills a half chunk into year N+1.
//   full_year — a whole chunk in the purchase year, over exactly N years. No US
//               convention actually allows this; it's the accountant's override
//               for an asset already being depreciated that way elsewhere.
//
// Rounding lives in the cents domain and the LAST row absorbs the remainder, so
// rows always sum to exactly `cost` — an asset must end fully written off, and
// a stray cent on a tax form is a support ticket.
export type DepreciationRow = { year: number; amount: string };

export type DepreciationPlan = {
  // The full-year chunk — the "then about $720 a year" figure. Not necessarily
  // the amount of any particular row (year one and the tail are halved under
  // half_year), so never post this directly; post from `rows`.
  perYear: string;
  // Amount in the purchase year specifically, which is what a user who just
  // logged the purchase actually wants to know.
  firstYear: string;
  // Count of posting years — lifeYears under full_year, lifeYears + 1 under
  // half_year.
  years: number;
  total: string;
  rows: DepreciationRow[];
};

export function depreciationSchedule(
  cost: string,
  lifeYears: number,
  opts: { convention: DepreciationConvention; purchaseYear: number },
): DepreciationPlan {
  const life = Math.max(1, Math.round(lifeYears));
  const totalCents = Math.round(Number(cost) * 100);
  const perYearCents = Math.round(totalCents / life);
  const halfYearCents = Math.round(perYearCents / 2);

  // Build the shape first, then true up the final row against the total.
  const amounts: number[] =
    opts.convention === 'half_year'
      ? [halfYearCents, ...Array(life - 1).fill(perYearCents), halfYearCents]
      : Array(life).fill(perYearCents);

  const lastIndex = amounts.length - 1;
  const beforeLast = amounts.slice(0, lastIndex).reduce((sum, c) => sum + c, 0);
  // Remainder to the last row. Clamped at 0 so a pathological life/cost combo
  // (a 1-year half_year plan, say) can't emit a negative final posting.
  amounts[lastIndex] = Math.max(0, totalCents - beforeLast);

  return {
    perYear: (perYearCents / 100).toFixed(2),
    firstYear: ((amounts[0] ?? 0) / 100).toFixed(2),
    years: amounts.length,
    total: (totalCents / 100).toFixed(2),
    rows: amounts.map((cents, i) => ({
      year: opts.purchaseYear + i,
      amount: (cents / 100).toFixed(2),
    })),
  };
}

// The yearly "spread it out" posting: write a slice of the asset's cost off as
// an expense, and net the same slice off the asset's book value.
//   Dr Depreciation Expense 6350      = amount  (lands on Schedule C line 13)
//   Cr Accumulated Depreciation 1900  = amount  (contra-asset; book value falls)
// Identical to the pair the §179 path already posts in one shot at purchase —
// the only difference is that this arrives a year at a time.
export function depreciationLines(amount: string): LedgerLine[] {
  return [
    { code: COA_DEPRECIATION_EXPENSE, side: 'debit', amount },
    { code: COA_ACCUM_DEPRECIATION, side: 'credit', amount },
  ];
}

// Depreciation postings carry their OWN source type rather than reusing
// 'capital_purchase'. Three reasons, all load-bearing: the delete path
// reconstructs the original purchase lines to reverse them and must not sweep
// these up; the sweeper's "which years are already posted?" query has to be
// exact, because a double-post into an append-only ledger can only be fixed by
// another entry; and provenance stays greppable. loanBalance is indifferent
// either way — it filters on COA 2700, which this never touches.
export const CAPITAL_PURCHASE_DEPRECIATION_SOURCE = 'capital_purchase_depreciation';

// A depreciation posting is dated 31 December of the year it covers, because a
// tax year is the unit it belongs to — dating it on the purchase anniversary
// would split one year's deduction across two Schedule Cs.
//
// Midnight UTC on that date is inside the target tax year for EVERY zone: the
// Schedule C window resolves through `AT TIME ZONE` (TMC-157), and even at the
// extremes (UTC-12 opens the year at 12:00Z on 1 Jan, UTC+14 closes it at
// 10:00Z on 31 Dec) Dec-31T00:00Z falls within. So the posting side needs no
// timezone plumbing, and reading the year back out in UTC is exact.
export function depreciationPostedAt(year: number): Date {
  return new Date(`${year}-12-31T00:00:00.000Z`);
}

export async function postDepreciation(
  tx: Database | Transaction,
  args: {
    purchaseId: string;
    description: string;
    year: number;
    amount: string;
    accountId: string;
    companyId: string;
  },
): Promise<string | null> {
  return postJournalEntry(tx, {
    accountId: args.accountId,
    companyId: args.companyId,
    sourceEntityType: CAPITAL_PURCHASE_DEPRECIATION_SOURCE,
    sourceEntityId: args.purchaseId,
    postedAt: depreciationPostedAt(args.year),
    memo: `Depreciation on ${args.description} (${args.year})`,
    lines: depreciationLines(args.amount),
  });
}

// Undo one year's depreciation, dated to the year it covered rather than today,
// so a reversal lands in the same tax year as the entry it cancels — otherwise
// deleting an old purchase would move a deduction off a filed year and onto the
// current one. Append-only: this posts a mirror entry, it never deletes rows.
export async function postDepreciationReversal(
  tx: Database | Transaction,
  args: {
    purchaseId: string;
    description: string;
    year: number;
    amount: string;
    accountId: string;
    companyId: string;
  },
): Promise<string | null> {
  return postJournalEntry(tx, {
    accountId: args.accountId,
    companyId: args.companyId,
    sourceEntityType: CAPITAL_PURCHASE_DEPRECIATION_SOURCE,
    sourceEntityId: args.purchaseId,
    postedAt: depreciationPostedAt(args.year),
    memo: `Depreciation on ${args.description} (${args.year}) reversal`,
    lines: reverseLedgerLines(depreciationLines(args.amount)),
  });
}

// What's already been depreciated on one purchase, per year. Derived from the
// ledger rather than tracked in a table — the same source-group pattern as
// loanBalance, and it means backfill needs no state of its own: "post the plan
// years that have passed and aren't in here" handles a purchase from 2023 and a
// re-run five minutes later with the same code path.
//
// Amounts (not just years) come back so the sweeper can clamp cumulative
// postings to cost. Reversals net into their year's total by construction, so a
// year that was posted and then reversed reads as 0.00 and posts again.
export async function depreciationPostedByYear(
  tx: Database | Transaction,
  scope: LedgerScope & { purchaseId: string },
): Promise<Map<number, string>> {
  // One expression object, used for both SELECT and GROUP BY so the two are
  // textually identical. 'UTC' is inlined rather than bound: a parameterised
  // zone renders as $n in one clause and not the other, and Postgres then
  // rejects the column as not grouped (TMC-157 footgun).
  const postedYear = sql<number>`extract(year from ${journalEntries.postedAt} at time zone 'UTC')::int`;
  const rows = await tx
    .select({
      year: postedYear.as('posted_year'),
      amount: sql<string>`coalesce(sum(case when ${journalLines.side} = 'debit' then ${journalLines.amount} else -${journalLines.amount} end), 0)::numeric(15,2)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
    .where(
      and(
        eq(journalEntries.companyId, scope.companyId),
        eq(journalEntries.accountId, scope.accountId),
        eq(journalEntries.sourceEntityType, CAPITAL_PURCHASE_DEPRECIATION_SOURCE),
        eq(journalEntries.sourceEntityId, scope.purchaseId),
        eq(chartOfAccounts.code, COA_DEPRECIATION_EXPENSE),
      ),
    )
    .groupBy(postedYear);
  return new Map(rows.map((r) => [Number(r.year), r.amount]));
}

// --- Manual journal entries ("The Ledger" portal) --------------------------
// The accountant persona's surface: balanced debit/credit lines the user posts
// directly against the chart of accounts, exactly as their CPA dictated. Unlike
// every other posting helper here, the lines reference chart_of_accounts by id
// (the client picks accounts from the COA) rather than by fixed code, and an
// original entry self-references its own id as source_entity_id. That self-
// reference matters: a later reversal points at the same id, so the two share a
// source group and cashFlowNet's per-source netting cancels them — the same
// reversal-safety every other entity gets for free.
//
// source_entity_type carries the provenance, distinct from every system posting:
//   'manual_adjustment'          — an original manual entry (source_entity_id = self)
//   'manual_adjustment_reversal' — a reversal of one    (source_entity_id = original)
// Append-only like the rest of the ledger: a correction is a reversing entry,
// never an edit. The caller (routes/ledger.ts) validates balance + that every
// coaAccountId belongs to the company before calling; this just writes the rows
// inside the tenant tx so the deferred sum-to-zero trigger verifies the entry at
// commit. No min-2 / amount filter here (unlike postJournalEntry) — the manual
// schema already guarantees ≥2 balanced, positive lines.

export const MANUAL_ADJUSTMENT_SOURCE = 'manual_adjustment';
export const MANUAL_ADJUSTMENT_REVERSAL_SOURCE = 'manual_adjustment_reversal';

export type ManualJournalLine = {
  coaAccountId: string;
  side: LedgerSide;
  amount: string;
};

// The account-id-keyed insert primitive. Exported because the year-end close
// (lib/period-close.ts) writes through it too — its lines are account-id-keyed
// for the same reason a manual entry's are (any account type, resolved from the
// company's own COA).
//
// Deliberately checks NEITHER lock. The closing entry and its reversal post at
// the boundary of the very period they open or close, so the period lock would
// fail them against their own close; and a retired company must still be
// closeable (its final year) and must still accept the entry that hands its
// balances over. Both locks live one level up, in postManualJournalEntry /
// reverseManualJournalEntry, which is where every caller that ISN'T a close or a
// handover goes through.
export async function insertEntryWithAccountIds(
  tx: Database | Transaction,
  spec: {
    entryId: string;
    accountId: string;
    companyId: string;
    sourceEntityType: string;
    sourceEntityId: string;
    postedAt: Date;
    memo: string;
    lines: ManualJournalLine[];
  },
): Promise<void> {
  await tx.insert(journalEntries).values({
    id: spec.entryId,
    accountId: spec.accountId,
    companyId: spec.companyId,
    sourceEntityType: spec.sourceEntityType,
    sourceEntityId: spec.sourceEntityId,
    postedAt: spec.postedAt,
    memo: spec.memo,
  });
  await tx.insert(journalLines).values(
    spec.lines.map((l) => ({
      id: uuidv7(),
      accountId: spec.accountId,
      journalEntryId: spec.entryId,
      coaAccountId: l.coaAccountId,
      side: l.side,
      amount: l.amount,
    })),
  );
}

// Posts a new manual entry. Generates the entry id and self-references it (so a
// future reversal can point at it and share its source group). Returns the id.
export async function postManualJournalEntry(
  tx: Database | Transaction,
  args: {
    accountId: string;
    companyId: string;
    postedAt: Date;
    memo: string;
    lines: ManualJournalLine[];
  },
): Promise<string> {
  // A manual adjustment into a closed year is exactly what the lock is for: the
  // accountant should re-open the year deliberately, not slip an entry behind
  // the close (see period-lock.ts).
  await assertPeriodOpen(tx, {
    accountId: args.accountId,
    companyId: args.companyId,
    postedAt: args.postedAt,
  });
  await assertCompanyActive(tx, { accountId: args.accountId, companyId: args.companyId });
  const entryId = uuidv7();
  await insertEntryWithAccountIds(tx, {
    entryId,
    accountId: args.accountId,
    companyId: args.companyId,
    sourceEntityType: MANUAL_ADJUSTMENT_SOURCE,
    sourceEntityId: entryId,
    postedAt: args.postedAt,
    memo: args.memo,
    lines: args.lines,
  });
  return entryId;
}

// Pure: the same lines with each side flipped (debit ↔ credit), account + amount
// preserved. The coaAccountId-keyed sibling of reverseLedgerLines. Sum-to-zero
// is preserved by symmetry, so a balanced original yields a balanced reversal.
export function flipManualLines(lines: ManualJournalLine[]): ManualJournalLine[] {
  return lines.map((l) => ({
    coaAccountId: l.coaAccountId,
    side: l.side === 'debit' ? 'credit' : 'debit',
    amount: l.amount,
  }));
}

// Posts the reversal of an existing manual entry: the original's lines flipped,
// tagged 'manual_adjustment_reversal' and pointing at the original's id. Dated
// at the original's posted_at so the period nets cleanly. Returns the reversal id.
export async function reverseManualJournalEntry(
  tx: Database | Transaction,
  args: {
    accountId: string;
    companyId: string;
    originalEntryId: string;
    originalLines: ManualJournalLine[];
    postedAt: Date;
    memo: string;
  },
): Promise<string> {
  // Reversals are dated at the original's posted_at, so reversing an entry from
  // a closed year would reach back behind the close — blocked for the same
  // reason a fresh adjustment is.
  await assertPeriodOpen(tx, {
    accountId: args.accountId,
    companyId: args.companyId,
    postedAt: args.postedAt,
  });
  await assertCompanyActive(tx, { accountId: args.accountId, companyId: args.companyId });
  const reversalId = uuidv7();
  await insertEntryWithAccountIds(tx, {
    entryId: reversalId,
    accountId: args.accountId,
    companyId: args.companyId,
    sourceEntityType: MANUAL_ADJUSTMENT_REVERSAL_SOURCE,
    sourceEntityId: args.originalEntryId,
    postedAt: args.postedAt,
    memo: args.memo,
    lines: flipManualLines(args.originalLines),
  });
  return reversalId;
}

// Thin wrapper: derives lines from the invoice + transition and posts.
// Caller is responsible for being inside a tx (tenant tx for mark-* on
// transitionInvoice, explicit bootstrap tx for the Stripe webhook path)
// — the deferred sum-to-zero trigger requires it.
export async function postInvoiceTransition(
  tx: Database | Transaction,
  args: {
    invoice: Pick<Invoice, 'id' | 'number' | 'subtotal' | 'tax' | 'total' | 'processingFee'>;
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
    // Read off the invoice row rather than passed in, so the webhook only has
    // to persist the fee before posting and every other caller is unchanged.
    processingFee: args.invoice.processingFee,
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
    // Collecting on an invoice the business had already sent is settlement, so a
    // retired company can still bank the cheque for work it billed under the old
    // name. Every other transition — issuing, voiding — is new business.
    intent: args.prevStatus === 'sent' && args.nextStatus === 'paid' ? 'settlement' : 'origination',
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
    invoice: Pick<Invoice, 'id' | 'number' | 'subtotal' | 'tax' | 'total' | 'processingFee'>;
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
    // Same stored fee feeds both the reversal and the re-post, so the origin
    // period nets to exactly zero. This is why the fee is persisted on the
    // invoice instead of re-fetched from Stripe at repost time.
    processingFee: args.invoice.processingFee,
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

// --- Invoice payments (TMC-187) --------------------------------------------
// One receipt against an issued invoice, posted on its own rather than as part
// of a whole-document status flip:
//   Dr Cash 1000                    = amount − fee
//   Dr Merchant Processing Fees 7950 = fee (0 on every manual channel)
//   Cr Accounts Receivable 1200      = amount
//
// This is the same shape the sent→paid transition has always posted, re-grained
// from "the invoice total" to "this receipt". A full payment therefore emits a
// byte-identical entry to the one the old single-shot path produced, which is
// what lets the two coexist while the header columns are still maintained.
//
// A payment requires an ISSUED invoice, because it relieves AR and a draft has
// no receivable. See the schema comment on invoice_payments for why taking a
// deposit against a draft would need an unearned-revenue account we deliberately
// have not added.
//
// NEGATIVE AMOUNTS are refunds and credit notes. The lines are built from the
// absolute value and then flipped, so a refund reads Cr Cash / Dr AR and nets
// against the receipt it undoes without a second concept. Note the fee leg flips
// with it: refunding a card payment would claw back the processor's cut, which
// Stripe does not actually do. Manual refunds pass no fee so they collapse to
// the clean two-line shape; a fee-bearing refund is not reachable from any
// surface today, and wiring one needs this decided rather than inherited.
export function invoicePaymentLines(args: {
  amount: string;
  processingFee?: string | null;
}): LedgerLine[] {
  const cents = Math.round(Number(args.amount) * 100);
  const gross = (Math.abs(cents) / 100).toFixed(2);
  const fee = args.processingFee ?? '0.00';
  const lines: LedgerLine[] = [
    { code: COA_CASH, side: 'debit', amount: subtractMoney(gross, fee) },
    { code: COA_MERCHANT_FEES, side: 'debit', amount: fee },
    { code: COA_AR, side: 'credit', amount: gross },
  ];
  return cents < 0 ? reverseLedgerLines(lines) : lines;
}

type InvoicePaymentPosting = {
  payment: { id: string; amount: string; processingFee?: string | null };
  invoice: { id: string; number: string };
  accountId: string;
  companyId: string;
  postedAt: Date;
};

// Posts one receipt. source_entity_id is the INVOICE, not the payment — so every
// entry for an invoice shares one source group and cashFlowNet's per-source
// netting keeps working exactly as it does for the single-shot path. A payment
// and its later reversal cancel inside that group for free.
export async function postInvoicePayment(
  tx: Database | Transaction,
  args: InvoicePaymentPosting,
): Promise<string | null> {
  return postJournalEntry(tx, {
    accountId: args.accountId,
    companyId: args.companyId,
    sourceEntityType: 'invoice',
    sourceEntityId: args.invoice.id,
    postedAt: args.postedAt,
    memo: `Invoice ${args.invoice.number} payment`,
    lines: invoicePaymentLines(args.payment),
    // Collecting on an invoice already issued is settlement, so a retired
    // company can still bank the cheque for work it billed under the old name.
    intent: 'settlement',
  });
}

// Undo one receipt, dated at the date it was posted rather than today — a
// reversal must land in the same reporting period as the entry it cancels, or
// deleting a mistake would move cash off a closed month and onto this one. The
// stored fee feeds both sides, which is why it is persisted on the row.
export async function postInvoicePaymentReversal(
  tx: Database | Transaction,
  args: InvoicePaymentPosting,
): Promise<string | null> {
  return postJournalEntry(tx, {
    accountId: args.accountId,
    companyId: args.companyId,
    sourceEntityType: 'invoice',
    sourceEntityId: args.invoice.id,
    postedAt: args.postedAt,
    memo: `Invoice ${args.invoice.number} payment reversal`,
    lines: reverseLedgerLines(invoicePaymentLines(args.payment)),
    intent: 'settlement',
  });
}

// --- Ledger read helpers (position dashboard + cash-flow nudges) -----------
// "cash" = the Cash account (1000); "owed" = the AR balance.
//
// These used to scope cash as "every asset account except AR", which equalled
// Cash only while Cash + AR were the sole asset accounts. The manual-adjustment
// portal introduced the first NON-cash asset (Accumulated Depreciation, 1900,
// a contra-asset), so the filter is now pinned to the Cash code explicitly:
// otherwise a manual depreciation entry (Cr 1900) would read as cash leaving
// the business. Single-Cash is the documented MVP assumption (see SOLE_PROP_COA)
// — when multiple cash/bank accounts land, this becomes a set membership.

type LedgerScope = { accountId: string; companyId: string };

// Reversal-safe cash flow over a half-open window [fromDate, toExclusive).
// Nets signed cash movement per source_entity_id BEFORE splitting by direction:
// the ledger is immutable, so editing/voiding an expense posts a reversing
// entry whose "Dr Cash" would otherwise read as money in and double the gross
// out. A create+edit collapses to the latest amount, a create+delete to zero
// (the dashboard reversal fix, #144). Returns 2-dp decimal strings.
// Bounds accept a SQL expression as well as a Date so callers can hand in an
// instant resolved through the company's timezone (`AT TIME ZONE`, TMC-157)
// rather than a UTC midnight. Drizzle's comparison helpers take either.
export async function cashFlowNet(
  tx: Database | Transaction,
  scope: LedgerScope & { fromDate: Date | SQL<Date>; toExclusive: Date | SQL<Date> },
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
        eq(chartOfAccounts.code, COA_CASH),
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

// Cash on hand: signed balance (debits − credits) on the Cash account (1000),
// all-time. A point-in-time balance is reversal-safe by construction (reversal
// pairs cancel), so no per-source netting is needed here. Pinned to the Cash
// code for the same reason as cashFlowNet — a non-cash asset (e.g. accumulated
// depreciation) must not count toward cash on hand.
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
        eq(chartOfAccounts.code, COA_CASH),
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
