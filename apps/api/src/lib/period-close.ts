import {
  type Database,
  type Transaction,
  chartOfAccounts,
  journalEntries,
  journalLines,
  periodCloses,
} from '@thalermark/db';
import { periodCloseEquityCode } from '@thalermark/validation';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { type ManualJournalLine, insertEntryWithAccountIds } from './ledger.js';

// Year-end close (TMC-159) — rolling a fiscal year's revenue and expense
// accounts into equity so the next year starts at zero, and locking the year.
//
// Sole proprietors got away without one because every report re-derives net
// income from the ledger on the fly. Corporations don't: Form 1120 / 1120-S
// Schedule L reports retained earnings as a REAL balance accumulating across
// years, and 3400 was seeded but nothing ever posted to it.
//
// The closing entry is an ordinary journal_entries row with its own
// source_entity_type, self-referencing like a manual adjustment so a later
// reversal shares its source group. It writes through the lock-free
// insertEntryWithAccountIds: the entry posts at the boundary of the very period
// it closes, so it would fail its own period check.

export const YEAR_END_CLOSE_SOURCE = 'year_end_close';
export const YEAR_END_CLOSE_REVERSAL_SOURCE = 'year_end_close_reversal';

// The draw / distribution / dividend account. Closed alongside the P&L accounts:
// left open it accumulates forever and the equity composition — the thing this
// feature exists to get right — stays wrong.
const COA_OWNER_DRAW = '3100';

// The instant a fiscal year ends, in the COMPANY's timezone
// ([[project_report_timezone]]) — i.e. the first instant of the following year,
// which is the exclusive upper bound of the closed period.
//
// Resolved in Postgres rather than JS for the same reason every report window
// is: `AT TIME ZONE` reads the tz database the server ships, so DST shifts and
// historical offset changes are handled. Both operands are bound parameters, so
// a stored zone string never becomes SQL.
export async function fiscalYearEndInstant(
  tx: Database | Transaction,
  args: { fiscalYear: number; timezone: string },
): Promise<Date> {
  const day = `${args.fiscalYear + 1}-01-01`;
  const result = await tx.execute<{ instant: Date }>(
    sql`select (${day}::timestamp AT TIME ZONE ${args.timezone}) as instant`,
  );
  const row = result.rows[0];
  if (!row) throw new Error('period-close: could not resolve fiscal year end');
  return new Date(row.instant);
}

// One account's running balance heading into the close, in raw debit-minus-
// credit terms (positive = net debit balance).
type AccountBalance = {
  coaAccountId: string;
  code: string;
  accountType: string;
  raw: number; // cents
};

// Every account the close has to zero, with its balance as of the close instant.
//
// THE RULE: this sums ALL activity strictly before the instant, INCLUDING prior
// closing entries — it reads the account's running balance, not the year's
// activity. That is what makes it self-correcting. Last year's close already
// zeroed these accounts, so it cancels last year's activity out of the sum and
// only the un-closed remainder rolls. Close 2026 with 2025 never closed and both
// roll; close 2026 with 2025 already closed and only 2026 rolls. Filtering prior
// closes OUT would double-count every previously closed year.
export async function closingBalances(
  tx: Database | Transaction,
  args: { accountId: string; companyId: string; closedThrough: Date },
): Promise<AccountBalance[]> {
  const rows = await tx
    .select({
      coaAccountId: chartOfAccounts.id,
      code: chartOfAccounts.code,
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
        sql`${journalEntries.postedAt} < ${args.closedThrough}`,
        or(
          inArray(chartOfAccounts.accountType, ['revenue', 'expense']),
          eq(chartOfAccounts.code, COA_OWNER_DRAW),
        ),
      ),
    )
    .groupBy(chartOfAccounts.id, chartOfAccounts.code, chartOfAccounts.accountType);

  return rows
    .map((r) => ({
      coaAccountId: r.coaAccountId,
      code: r.code,
      accountType: r.accountType,
      raw: Math.round(Number(r.raw) * 100),
    }))
    .filter((r) => r.raw !== 0);
}

export type ClosingPlan = {
  lines: ManualJournalLine[];
  // Profit for the un-closed span, positive for a profit. Revenue − expenses
  // only: withdrawals are an equity movement, not a cost of doing business, so
  // they roll without touching the reported figure.
  netIncome: string;
  // Total withdrawals rolled (positive), reported so the UI can say what moved.
  withdrawals: string;
  equityCode: string;
};

// Turn the balances into the closing entry's lines.
//
// Each account is zeroed by posting the opposite of its balance: a net debit
// balance is closed with a credit, and vice versa. The equity plug is then
// whatever makes the entry balance, which by construction is the net of
// everything closed — a profit credits equity, a loss debits it.
export function buildClosingPlan(
  balances: AccountBalance[],
  equity: { coaAccountId: string; code: string },
): ClosingPlan | null {
  const lines: ManualJournalLine[] = [];
  let plugCents = 0;
  let netIncomeCents = 0;
  let withdrawalCents = 0;

  for (const b of balances) {
    // Flip: raw > 0 (net debit) closes with a credit of the same size.
    lines.push({
      coaAccountId: b.coaAccountId,
      side: b.raw > 0 ? 'credit' : 'debit',
      amount: (Math.abs(b.raw) / 100).toFixed(2),
    });
    plugCents += b.raw;
    if (b.accountType === 'revenue' || b.accountType === 'expense') {
      // Revenue carries a credit balance (raw negative), expenses a debit one,
      // so profit is exactly the negated sum.
      netIncomeCents -= b.raw;
    } else {
      withdrawalCents += b.raw;
    }
  }

  // A break-even span needs no plug — the flipped lines already balance each
  // other. Only an actual profit or loss moves equity.
  if (plugCents !== 0) {
    lines.push({
      coaAccountId: equity.coaAccountId,
      side: plugCents > 0 ? 'debit' : 'credit',
      amount: (Math.abs(plugCents) / 100).toFixed(2),
    });
  }

  // Nothing on the books, or a single account that nets to nothing — either way
  // there is no balanced entry to post and no close to record.
  if (lines.length < 2) return null;

  return {
    lines,
    netIncome: (netIncomeCents / 100).toFixed(2),
    withdrawals: (withdrawalCents / 100).toFixed(2),
    equityCode: equity.code,
  };
}

// Resolve the equity account a company's profit rolls into — 3400 Retained
// Earnings for the two corp types, 3000 Owner's Equity / Partners' Capital for
// everyone else (3400 isn't seeded for them). Returns null when the account is
// missing, which means the COA seed is broken for this company.
export async function resolveEquityTarget(
  tx: Database | Transaction,
  args: { accountId: string; companyId: string; businessType: string | null },
): Promise<{ coaAccountId: string; code: string } | null> {
  const code = periodCloseEquityCode(args.businessType);
  const [row] = await tx
    .select({ id: chartOfAccounts.id, code: chartOfAccounts.code })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.accountId, args.accountId),
        eq(chartOfAccounts.companyId, args.companyId),
        eq(chartOfAccounts.code, code),
      ),
    )
    .limit(1);
  return row ? { coaAccountId: row.id, code: row.code } : null;
}

// Post the closing entry and record the period_closes row, in one transaction.
// The entry is dated one millisecond before the close instant so it lands inside
// the year it closes: the balance sheet as of 31 Dec includes it, and the P&L
// for that year would too — which is exactly why the P&L and Schedule C
// worksheet filter this source type out.
export async function postYearEndClose(
  tx: Database | Transaction,
  args: {
    accountId: string;
    companyId: string;
    fiscalYear: number;
    closedThrough: Date;
    // Already carries the equity plug as its last line — buildClosingPlan put it
    // there, so there is nothing more to resolve here.
    plan: ClosingPlan;
  },
): Promise<{ periodCloseId: string; journalEntryId: string }> {
  const entryId = uuidv7();
  await insertEntryWithAccountIds(tx, {
    entryId,
    accountId: args.accountId,
    companyId: args.companyId,
    sourceEntityType: YEAR_END_CLOSE_SOURCE,
    sourceEntityId: entryId,
    postedAt: new Date(args.closedThrough.getTime() - 1),
    memo: `Year-end close ${args.fiscalYear}`,
    lines: args.plan.lines,
  });

  const periodCloseId = uuidv7();
  await tx.insert(periodCloses).values({
    id: periodCloseId,
    accountId: args.accountId,
    companyId: args.companyId,
    fiscalYear: args.fiscalYear,
    closedThrough: args.closedThrough,
    journalEntryId: entryId,
    netIncome: args.plan.netIncome,
    equityCode: args.plan.equityCode,
  });

  return { periodCloseId, journalEntryId: entryId };
}

// Re-open a closed year: post the reversal of its closing entry and soft-delete
// the period_closes row. Append-only like everything else in the ledger — the
// original close is never edited or removed, and the two entries share a source
// group so the pair nets out.
export async function reverseYearEndClose(
  tx: Database | Transaction,
  args: {
    accountId: string;
    companyId: string;
    periodCloseId: string;
    journalEntryId: string;
    fiscalYear: number;
    closedThrough: Date;
  },
): Promise<string> {
  const originalLines = await tx
    .select({
      coaAccountId: journalLines.coaAccountId,
      side: journalLines.side,
      amount: journalLines.amount,
    })
    .from(journalLines)
    .where(
      and(
        eq(journalLines.accountId, args.accountId),
        eq(journalLines.journalEntryId, args.journalEntryId),
      ),
    );

  const reversalId = uuidv7();
  await insertEntryWithAccountIds(tx, {
    entryId: reversalId,
    accountId: args.accountId,
    companyId: args.companyId,
    sourceEntityType: YEAR_END_CLOSE_REVERSAL_SOURCE,
    sourceEntityId: args.journalEntryId,
    postedAt: new Date(args.closedThrough.getTime() - 1),
    memo: `Re-opened ${args.fiscalYear}`,
    lines: originalLines.map((l) => ({
      coaAccountId: l.coaAccountId,
      side: l.side === 'debit' ? ('credit' as const) : ('debit' as const),
      amount: l.amount,
    })),
  });

  await tx
    .update(periodCloses)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(periodCloses.id, args.periodCloseId),
        eq(periodCloses.accountId, args.accountId),
        isNull(periodCloses.deletedAt),
      ),
    );

  return reversalId;
}
