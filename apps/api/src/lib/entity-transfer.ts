import {
  type Transaction,
  capitalPurchases,
  chartOfAccounts,
  journalEntries,
  journalLines,
} from '@thalermark/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { type ManualJournalLine, insertEntryWithAccountIds, loanBalance } from './ledger.js';

// Handing one business's books to another — a sole proprietor incorporating.
//
// Structured as a near-sibling of period-close.ts, because it is the same shape
// of problem: read every account's RAW balance, post the opposite to zero it,
// plug the difference to equity. That "raw" is load-bearing. 1900 Accumulated
// Depreciation is a contra-asset seeded debit-normal but carrying a credit
// balance; 3100 is credit-normal but carries a debit balance. Working in
// normal-balance direction would credit 1900 and DOUBLE it. Working in raw
// debit-minus-credit terms needs no special cases at all.

export const TRANSFER_OUT_SOURCE = 'entity_transfer_out';
export const TRANSFER_IN_SOURCE = 'entity_transfer_in';
export const TRANSFER_OUT_REVERSAL_SOURCE = 'entity_transfer_out_reversal';
export const TRANSFER_IN_REVERSAL_SOURCE = 'entity_transfer_in_reversal';

// Where the predecessor's net assets go, and where they arrive.
const COA_TRANSFERRED_OUT = '3900';
const COA_OWNER_EQUITY = '3000';
// Excluded from the aggregate entries and handled per purchase — see
// transferLoanLegs for why.
const COA_LOANS_PAYABLE = '2700';
const COA_AR = '1200';

export type AccountBalance = {
  coaAccountId: string;
  code: string;
  // The account's own words ("Cash", "Vehicles & Equipment"). Carried so a
  // preview can name what moves rather than showing a bare 4-digit code — the
  // whole product hides accounting vocabulary, and a code is the purest form of
  // it.
  name: string;
  accountType: string;
  raw: number; // cents, debit-positive
};

// Every balance-sheet account carrying a balance on the predecessor as of the
// transfer instant. Revenue and expense accounts are deliberately NOT included:
// the predecessor's stub-period profit and loss stays on its books for the final
// return, and the identity means the equity plug lands at exactly zero anyway.
export async function transferableBalances(
  tx: Transaction,
  args: { accountId: string; companyId: string; asOf: Date; excludeCodes?: string[] },
): Promise<AccountBalance[]> {
  const excluded = new Set([COA_LOANS_PAYABLE, ...(args.excludeCodes ?? [])]);
  const rows = await tx
    .select({
      coaAccountId: chartOfAccounts.id,
      code: chartOfAccounts.code,
      name: chartOfAccounts.name,
      accountType: chartOfAccounts.accountType,
      raw: sql<string>`sum(case when ${journalLines.side} = 'debit' then ${journalLines.amount} else -${journalLines.amount} end)::numeric(15,2)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
    .where(
      and(
        eq(journalEntries.accountId, args.accountId),
        eq(journalEntries.companyId, args.companyId),
        sql`${journalEntries.postedAt} < ${args.asOf}`,
        inArray(chartOfAccounts.accountType, ['asset', 'liability']),
      ),
    )
    .groupBy(
      chartOfAccounts.id,
      chartOfAccounts.code,
      chartOfAccounts.name,
      chartOfAccounts.accountType,
    );

  return rows
    .map((r) => ({
      coaAccountId: r.coaAccountId,
      code: r.code,
      name: r.name,
      accountType: r.accountType,
      raw: Math.round(Number(r.raw) * 100),
    }))
    .filter((r) => r.raw !== 0 && !excluded.has(r.code));
}

export type TransferPlan = {
  // Keyed by code, because the same plan has to be resolved against TWO charts:
  // the predecessor's on the way out and the successor's on the way in. Codes
  // are identical across all five entity types by design.
  legs: { code: string; side: 'debit' | 'credit'; amount: string }[];
  // What the predecessor handed over, net. Positive for a solvent business.
  netAssets: string;
};

// Flip every balance and plug the difference. Identical in shape to
// buildClosingPlan, over balance-sheet accounts instead of P&L ones.
export function buildTransferPlan(balances: AccountBalance[]): TransferPlan | null {
  const legs: TransferPlan['legs'] = [];
  let plugCents = 0;

  for (const b of balances) {
    // raw > 0 (a net debit balance, e.g. cash) is zeroed with a credit.
    legs.push({
      code: b.code,
      side: b.raw > 0 ? 'credit' : 'debit',
      amount: (Math.abs(b.raw) / 100).toFixed(2),
    });
    plugCents += b.raw;
  }

  if (legs.length === 0 || plugCents === 0) return null;

  legs.push({
    code: COA_TRANSFERRED_OUT,
    side: plugCents > 0 ? 'debit' : 'credit',
    amount: (Math.abs(plugCents) / 100).toFixed(2),
  });

  return { legs, netAssets: (plugCents / 100).toFixed(2) };
}

// Resolve a code-keyed plan against one company's chart. Returns the unmapped
// codes rather than inventing accounts: a corporation's payroll-tax liability
// has no home on a Schedule C chart, and silently seeding one would put a
// balance on a line that entity never files.
export async function resolveLegs(
  tx: Transaction,
  args: { accountId: string; companyId: string; legs: TransferPlan['legs']; plugCode: string },
): Promise<{ lines: ManualJournalLine[] } | { unmapped: string[] }> {
  const codes = Array.from(new Set(args.legs.map((l) => l.code)));
  // The plug differs by side: 3900 on the way out, 3000 on the way in (§351 is
  // a contribution of assets in exchange for stock, and 3000 is already the
  // opening-balance plug).
  const wanted = codes.map((c) => (c === COA_TRANSFERRED_OUT ? args.plugCode : c));

  const rows = await tx
    .select({ id: chartOfAccounts.id, code: chartOfAccounts.code })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.accountId, args.accountId),
        eq(chartOfAccounts.companyId, args.companyId),
        inArray(chartOfAccounts.code, wanted),
      ),
    );
  const byCode = new Map(rows.map((r) => [r.code, r.id]));
  const unmapped = wanted.filter((c) => !byCode.has(c));
  if (unmapped.length > 0) return { unmapped };

  return {
    lines: args.legs.map((l) => ({
      coaAccountId: byCode.get(l.code === COA_TRANSFERRED_OUT ? args.plugCode : l.code) as string,
      side: l.side,
      amount: l.amount,
    })),
  };
}

// Post one side of the handoff. Uses the lock-free id-keyed primitive for the
// same reasons the year-end close does: the lines are account-id-keyed against
// an arbitrary set of accounts, and the predecessor is being retired in this
// very transaction. The period lock is asserted once by the caller, explicitly,
// for BOTH companies.
export async function postTransferEntry(
  tx: Transaction,
  args: {
    accountId: string;
    companyId: string;
    transferId: string;
    lines: ManualJournalLine[];
    postedAt: Date;
    sourceEntityType: string;
    memo: string;
  },
): Promise<string> {
  const entryId = uuidv7();
  await insertEntryWithAccountIds(tx, {
    entryId,
    accountId: args.accountId,
    companyId: args.companyId,
    sourceEntityType: args.sourceEntityType,
    // The transfer, not the entry — so both sides and any later reversal share
    // one source group.
    sourceEntityId: args.transferId,
    postedAt: args.postedAt,
    memo: args.memo,
    lines: args.lines,
  });
  return entryId;
}

export type TransferringLoan = {
  purchaseId: string;
  successorPurchaseId: string;
  outstanding: string;
};

// Loans move per purchase, NOT in the aggregate entry.
//
// loanBalance derives what is still owed by summing 2700 across the journal
// entries tagged with a purchase's id. An aggregate Cr 2700 carries no purchase
// id, so it would be invisible to that query: the successor's transferred mower
// would read as fully paid off, and recording a payment against it would fail.
// So 2700 is excluded from transferableBalances and handled here, one small
// entry per financed purchase on each side, tagged with the purchase id the way
// every other loan posting is.
export async function transferLoanLegs(
  tx: Transaction,
  args: {
    accountId: string;
    predecessorCompanyId: string;
    successorCompanyId: string;
    loans: TransferringLoan[];
    transferId: string;
    postedAt: Date;
  },
): Promise<void> {
  if (args.loans.length === 0) return;

  const codeIds = async (companyId: string) => {
    const rows = await tx
      .select({ id: chartOfAccounts.id, code: chartOfAccounts.code })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.accountId, args.accountId),
          eq(chartOfAccounts.companyId, companyId),
          inArray(chartOfAccounts.code, [COA_LOANS_PAYABLE, COA_TRANSFERRED_OUT, COA_OWNER_EQUITY]),
        ),
      );
    return new Map(rows.map((r) => [r.code, r.id]));
  };
  const outIds = await codeIds(args.predecessorCompanyId);
  const inIds = await codeIds(args.successorCompanyId);

  for (const loan of args.loans) {
    const cents = Math.round(Number(loan.outstanding) * 100);
    if (cents <= 0) continue;
    const amount = (cents / 100).toFixed(2);

    // Predecessor: clear the liability against the transfer plug, tagged with
    // the ORIGINAL purchase id so its loanBalance reads zero afterwards.
    await insertEntryWithAccountIds(tx, {
      entryId: uuidv7(),
      accountId: args.accountId,
      companyId: args.predecessorCompanyId,
      sourceEntityType: 'capital_purchase',
      sourceEntityId: loan.purchaseId,
      postedAt: args.postedAt,
      memo: 'Loan transferred out',
      lines: [
        { coaAccountId: outIds.get(COA_LOANS_PAYABLE) as string, side: 'debit', amount },
        { coaAccountId: outIds.get(COA_TRANSFERRED_OUT) as string, side: 'credit', amount },
      ],
    });

    // Successor: take it on, tagged with the NEW purchase id so its own
    // loanBalance reports correctly from day one.
    await insertEntryWithAccountIds(tx, {
      entryId: uuidv7(),
      accountId: args.accountId,
      companyId: args.successorCompanyId,
      sourceEntityType: 'capital_purchase',
      sourceEntityId: loan.successorPurchaseId,
      postedAt: args.postedAt,
      memo: 'Loan taken over',
      lines: [
        { coaAccountId: inIds.get(COA_OWNER_EQUITY) as string, side: 'debit', amount },
        { coaAccountId: inIds.get(COA_LOANS_PAYABLE) as string, side: 'credit', amount },
      ],
    });
  }
}

export type TransferringAsset = {
  purchase: {
    id: string;
    description: string;
    amount: string;
    purchaseDate: string;
    usefulLifeYears: number;
    taxTreatment: string;
    funding: string;
    downPayment: string;
    priorAccumulatedDepreciation: string;
  };
  // What has been written off so far on the predecessor's books, including
  // anything IT carried in.
  accumulated: string;
  outstandingLoan: string;
};

// Everything the predecessor still owns that the successor could take on.
export async function transferableAssets(
  tx: Transaction,
  args: { accountId: string; companyId: string },
): Promise<TransferringAsset[]> {
  const rows = await tx
    .select()
    .from(capitalPurchases)
    .where(
      and(
        eq(capitalPurchases.accountId, args.accountId),
        eq(capitalPurchases.companyId, args.companyId),
        isNull(capitalPurchases.deletedAt),
      ),
    );

  const out: TransferringAsset[] = [];
  for (const p of rows) {
    const posted = await tx
      .select({
        total: sql<string>`coalesce(sum(case when ${journalLines.side} = 'credit' then ${journalLines.amount} else -${journalLines.amount} end), 0)::numeric(15,2)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
      .where(
        and(
          eq(journalEntries.accountId, args.accountId),
          eq(journalEntries.sourceEntityId, p.id),
          eq(chartOfAccounts.code, '1900'),
        ),
      );
    const accumulatedCents =
      Math.round(Number(posted[0]?.total ?? '0') * 100) +
      Math.round(Number(p.priorAccumulatedDepreciation) * 100);

    out.push({
      purchase: {
        id: p.id,
        description: p.description,
        amount: p.amount,
        purchaseDate: p.purchaseDate,
        usefulLifeYears: p.usefulLifeYears,
        taxTreatment: p.taxTreatment,
        funding: p.funding,
        downPayment: p.downPayment,
        priorAccumulatedDepreciation: p.priorAccumulatedDepreciation,
      },
      accumulated: (accumulatedCents / 100).toFixed(2),
      outstandingLoan:
        p.funding === 'financed'
          ? await loanBalance(tx, {
              accountId: args.accountId,
              companyId: args.companyId,
              purchaseId: p.id,
            })
          : '0.00',
    });
  }
  return out;
}

// Recreate the transferring assets on the successor at CARRIED BASIS. §351: the
// corporation steps into the transferor's shoes, so the original cost, life and
// clock all carry, and what has already been written off becomes the successor's
// prior_accumulated_depreciation. It does not restart — restarting would
// overstate the deduction in later years.
//
// No create posting is made: the asset's 1500/1900 balances arrive through the
// aggregate transfer-in entry. transferred_from_purchase_id is what tells the
// delete path not to reverse a create that never happened.
export async function createCarriedAssets(
  tx: Transaction,
  args: {
    accountId: string;
    successorCompanyId: string;
    assets: TransferringAsset[];
    effectiveDate: string;
  },
): Promise<Map<string, string>> {
  const idMap = new Map<string, string>();
  if (args.assets.length === 0) return idMap;

  const startYear = Number(args.effectiveDate.slice(0, 4));
  await tx.insert(capitalPurchases).values(
    args.assets.map((a) => {
      const id = uuidv7();
      idMap.set(a.purchase.id, id);
      return {
        id,
        accountId: args.accountId,
        companyId: args.successorCompanyId,
        description: a.purchase.description,
        // Original cost, not net book value — carryover basis.
        amount: a.purchase.amount,
        purchaseDate: a.purchase.purchaseDate,
        funding: a.purchase.funding,
        downPayment: a.purchase.downPayment,
        taxTreatment: a.purchase.taxTreatment,
        usefulLifeYears: a.purchase.usefulLifeYears,
        priorAccumulatedDepreciation: a.accumulated,
        // The successor's first depreciable year is the one it took over in.
        depreciationStartYear: startYear,
        transferredFromPurchaseId: a.purchase.id,
      };
    }),
  );
  return idMap;
}

export { COA_AR, COA_OWNER_EQUITY, COA_TRANSFERRED_OUT, COA_LOANS_PAYABLE };
