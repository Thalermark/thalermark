import {
  type Database,
  type Invoice,
  type Transaction,
  chartOfAccounts,
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
// has to follow. Service Revenue (4000) is used for all revenue postings
// in MVP; Product Revenue (4100) is in the COA but trades pass materials
// through as billed line items, so a separate product/service flag on
// line items is a v1.x add. Sales Tax Payable (2200) is only touched when
// the invoice carries tax > 0.
const COA_CASH = '1000';
// Exported for the position dashboard (slice 8.10): "money in/out" sums cash
// movement across asset accounts *except* AR, and "owed" is the AR balance.
export const COA_AR = '1200';
const COA_SALES_TAX_PAYABLE = '2200';
const COA_REVENUE = '4000';

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
// Posting matrix:
//   draft  → sent    Dr AR=total, Cr Rev=subtotal, Cr Tax=tax (if>0)
//   draft  → paid    Dr Cash=total, Cr Rev=subtotal, Cr Tax=tax (if>0)
//   sent   → paid    Dr Cash=total, Cr AR=total
//   sent   → voided  Dr Rev=subtotal, Dr Tax=tax (if>0), Cr AR=total
//   draft  → voided  (nothing — no prior posting to reverse)
//
// Lines with amount=0 are dropped by postJournalEntry, so a tax=0 invoice
// emits a 2-line entry (revenue, AR) without the empty tax line.
export function invoicePostingLines(
  prevStatus: InvoiceStatusForPosting,
  nextStatus: InvoiceStatusForPosting,
  amounts: { subtotal: string; tax: string; total: string },
): LedgerLine[] {
  const { subtotal, tax, total } = amounts;

  if (prevStatus === 'draft' && nextStatus === 'sent') {
    return [
      { code: COA_AR, side: 'debit', amount: total },
      { code: COA_REVENUE, side: 'credit', amount: subtotal },
      { code: COA_SALES_TAX_PAYABLE, side: 'credit', amount: tax },
    ];
  }
  if (prevStatus === 'draft' && nextStatus === 'paid') {
    return [
      { code: COA_CASH, side: 'debit', amount: total },
      { code: COA_REVENUE, side: 'credit', amount: subtotal },
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
      { code: COA_REVENUE, side: 'debit', amount: subtotal },
      { code: COA_SALES_TAX_PAYABLE, side: 'debit', amount: tax },
      { code: COA_AR, side: 'credit', amount: total },
    ];
  }
  return [];
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
  const lines = invoicePostingLines(args.prevStatus, args.nextStatus, {
    subtotal: args.invoice.subtotal,
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
