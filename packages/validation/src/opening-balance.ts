import { z } from 'zod';
import { isoDateString, moneyString } from './money.js';

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
