import { z } from 'zod';
import { isoDateString, moneyString, sumMoney } from './money.js';

// Manual journal entries — the accountant persona's surface ("The Ledger"
// portal). Unlike every other ledger-aware entity (invoices, expenses, bills,
// owner money events) the double-entry is NOT hidden here: this is the one
// deliberate place accounting vocabulary lives. The user (owner / admin /
// accountant, gated by the `ledger:adjust` capability) types balanced debit/
// credit lines against the chart of accounts, exactly as their CPA dictated.
//
// A manual entry IS a journal_entries row (source_entity_type='manual_adjustment',
// self-referencing source_entity_id) — there is no separate domain table. The
// double-entry stays balanced by the same deferred sum-to-zero trigger every
// system posting relies on; this schema validates balance up front so an
// unbalanced submission is a clean 400, not a transaction abort at commit.
//
// Append-only: a mistake is fixed with a reversing entry (POST .../reverse),
// never an edit — so there is no update schema here.

export const JOURNAL_LINE_SIDES = ['debit', 'credit'] as const;
export type JournalLineSide = (typeof JOURNAL_LINE_SIDES)[number];

// One posting line: which account, which side, how much. The account is picked
// by id from the company's chart of accounts (GET /api/companies/:id/accounts);
// the API re-validates that the id belongs to the company before posting.
// amount is a positive decimal string ([[architecture_money_decimal_strings]]);
// the > 0 check lives in the entry-level superRefine so it can point at the
// exact offending line.
export const manualJournalLineSchema = z.object({
  coaAccountId: z.string().uuid(),
  side: z.enum(JOURNAL_LINE_SIDES),
  amount: moneyString,
});

export type ManualJournalLineInput = z.infer<typeof manualJournalLineSchema>;

export const manualJournalEntryCreateSchema = z
  .object({
    companyId: z.string().uuid(),
    // The effective ledger date (drives which period the entry lands in — e.g.
    // a year-end adjustment dated 12-31). Maps to journal_entries.posted_at.
    postedOn: isoDateString,
    // The narrative the GL + audit trail carry ("2025 depreciation per CPA").
    // Required — a manual adjustment with no explanation is an audit gap.
    memo: z.string().trim().min(3, 'memo is required').max(500),
    // At least two lines (a debit + a credit), bounded so a runaway payload
    // can't be posted. Per-line amount/balance rules are in the superRefine.
    lines: z.array(manualJournalLineSchema).min(2, 'at least two lines').max(100),
  })
  .superRefine((value, ctx) => {
    // Every line must move a positive amount — moneyString admits "0"/"0.00",
    // but a zero-amount line is a no-op that would also break the >= 2
    // meaningful-lines invariant the posting helper relies on.
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
    // comparison is exact at the money scale (no IEEE-754 drift). Mirrors what
    // the deferred journal_lines sum-to-zero trigger enforces at commit, but as
    // a 400 the client can show inline.
    const debits = sumMoney(value.lines.filter((l) => l.side === 'debit').map((l) => l.amount));
    const credits = sumMoney(value.lines.filter((l) => l.side === 'credit').map((l) => l.amount));
    if (debits !== credits) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `entry does not balance: debits ${debits} ≠ credits ${credits}`,
        path: ['lines'],
      });
    }
  });

export type ManualJournalEntryCreateInput = z.infer<typeof manualJournalEntryCreateSchema>;
