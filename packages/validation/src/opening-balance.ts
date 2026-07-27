import { z } from 'zod';
import { isoDateString, moneyString, sumMoney } from './money.js';

// Opening balances — what the business already had when it started using
// Thalermark. Surfaced in "My Money" in plain language; the double-entry is
// hidden ([[project_ledger_decision]]). One per company (upsert), so this is a
// PUT, not a create/update pair.
//
// Three non-negative figures: cash in the bank at the start, money customers
// already owed (receivables), money already owed to others (payables). The
// server posts a single combined balanced entry against Owner's Equity (see the
// opening_balances schema). At least one figure must be > 0 — an all-zero
// opening balance is nothing to record (clearing is a DELETE, not a zero PUT).
// amounts are decimal strings ([[architecture_money_decimal_strings]]); each is
// optional and defaults to "0" so a form can omit the blanks. asOfDate is the
// start date the entry posts at.
export const openingBalanceUpsertSchema = z
  .object({
    companyId: z.string().uuid(),
    asOfDate: isoDateString,
    cash: moneyString.optional().default('0'),
    receivables: moneyString.optional().default('0'),
    payables: moneyString.optional().default('0'),
  })
  .superRefine((v, ctx) => {
    if (!(Number(v.cash) > 0 || Number(v.receivables) > 0 || Number(v.payables) > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter at least one amount.',
        path: ['cash'],
      });
    }
  });

export type OpeningBalanceUpsertInput = z.infer<typeof openingBalanceUpsertSchema>;

// The full shape — an opening trial balance, account by account. What Xero calls
// "conversion balances" and what anyone arriving with real books actually has.
//
// The three plain questions above are the right first ask and stay the default,
// but they can only ever say cash / owed to you / you owe. They cannot express a
// part-depreciated mower, an outstanding loan, sales tax already collected, or a
// corporation's split between capital stock and retained earnings — all of which
// a business that has been trading for years genuinely has.
//
// Same line shape as a manual journal entry (see journal-entry.ts), for the same
// reason: `moneyString` is unsigned, so direction has to live in `side`. That
// also means the two can share the balance check, and an accountant meets one
// idea instead of two.
export const openingBalanceLineSchema = z.object({
  coaAccountId: z.string().uuid(),
  side: z.enum(['debit', 'credit']),
  amount: moneyString,
});

export type OpeningBalanceLineInput = z.infer<typeof openingBalanceLineSchema>;

export const openingBalanceFullUpsertSchema = z
  .object({
    companyId: z.string().uuid(),
    asOfDate: isoDateString,
    // Bounded like a manual entry: enough for a real chart, small enough that a
    // runaway payload can't be posted.
    lines: z.array(openingBalanceLineSchema).min(2, 'at least two lines').max(200),
  })
  .superRefine((value, ctx) => {
    value.lines.forEach((line, i) => {
      if (!(Number(line.amount) > 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'amount must be greater than zero',
          path: ['lines', i, 'amount'],
        });
      }
    });

    // Debits must equal credits. Summed with the BigInt-backed sumMoney so the
    // comparison is exact at the money scale — the same check a manual journal
    // entry gets, and the same reason: a clean 400 the client can show inline
    // beats a deferred trigger aborting the transaction at commit.
    const debits = sumMoney(value.lines.filter((l) => l.side === 'debit').map((l) => l.amount));
    const credits = sumMoney(value.lines.filter((l) => l.side === 'credit').map((l) => l.amount));
    if (debits !== credits) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `opening balances don't balance: debits ${debits} ≠ credits ${credits}`,
        path: ['lines'],
      });
    }

    // One line per account. Two lines on the same account would still balance and
    // still post, but "the opening balance of account X" would have two answers,
    // and an edit could not round-trip.
    const seen = new Set<string>();
    for (const [i, line] of value.lines.entries()) {
      if (seen.has(line.coaAccountId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'each account can appear only once',
          path: ['lines', i, 'coaAccountId'],
        });
      }
      seen.add(line.coaAccountId);
    }
  });

export type OpeningBalanceFullUpsertInput = z.infer<typeof openingBalanceFullUpsertSchema>;
