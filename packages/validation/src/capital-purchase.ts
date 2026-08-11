import { z } from 'zod';
import { isoDateString, moneyString } from './money.js';

// Capital purchases — "big purchases" in plain language: durable gear bought and
// used for years (a mower on payments). The client supplies the visible facts;
// the hidden double-entry + the accountant vocabulary stay server-side
// ([[project_ledger_decision]], [[project_plain_language_money_out]]). The user
// answers life-questions: what did you buy, how much, paid now or over time, and
// how to handle it on taxes.

// 'paid_in_full' — bought outright; 'financed' — bought on payments (a loan).
export const CAPITAL_PURCHASE_FUNDING = ['paid_in_full', 'financed'] as const;
export type CapitalPurchaseFunding = (typeof CAPITAL_PURCHASE_FUNDING)[number];

// 'deduct_now' — "deduct it all this year" (§179, the default); 'spread' —
// "spread it out over the years you'll use it" (depreciate over its life).
export const CAPITAL_PURCHASE_TAX_TREATMENT = ['deduct_now', 'spread'] as const;
export type CapitalPurchaseTaxTreatment = (typeof CAPITAL_PURCHASE_TAX_TREATMENT)[number];

export const capitalPurchaseCreateSchema = z
  .object({
    companyId: z.string().uuid(),
    description: z.string().trim().min(1, 'Tell us what you bought.').max(200),
    amount: moneyString,
    purchaseDate: isoDateString,
    funding: z.enum(CAPITAL_PURCHASE_FUNDING),
    // Cash paid up front. Required meaning: for paid_in_full it's the whole
    // amount; for financed it's the down payment (0 if none). Optional on the
    // wire — the refine fills the paid_in_full case and bounds the financed one.
    downPayment: moneyString.optional(),
    // Which money account the down payment came out of — a mower is as likely
    // to go on the card as out of checking. Omitted → the primary account,
    // which is where every purchase before TMC-207 was paid from.
    paymentAccountId: z.string().uuid().optional(),
    taxTreatment: z.enum(CAPITAL_PURCHASE_TAX_TREATMENT),
    // Useful life for the 'spread' path; defaulted server-side, so optional and
    // bounded loosely here (1..40 years).
    usefulLifeYears: z.number().int().min(1).max(40).optional(),
    vendorContactId: z.string().uuid().optional(),
    memo: z.string().max(5000).optional(),
    // --- Already part-way through its life -----------------------------------
    // For an asset that was depreciated somewhere else before it got here: an
    // accountant entering a mower bought two years ago, or an incorporation
    // handoff (§351 carryover basis — same cost, same life, same clock).
    //
    // Both omitted is the ordinary case and behaves exactly as before.
    priorAccumulatedDepreciation: moneyString.optional(),
    depreciationStartYear: z.number().int().min(1900).max(2999).optional(),
  })
  .superRefine((v, ctx) => {
    const amount = Number(v.amount);
    // Can't already have written off more than it cost.
    if (
      v.priorAccumulatedDepreciation !== undefined &&
      Number(v.priorAccumulatedDepreciation) > amount
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "That's more than the asset cost.",
        path: ['priorAccumulatedDepreciation'],
      });
    }
    // Depreciation can't start before the asset existed.
    const purchaseYear = Number(v.purchaseDate.slice(0, 4));
    if (v.depreciationStartYear !== undefined && v.depreciationStartYear < purchaseYear) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Depreciation can't start before the purchase year.",
        path: ['depreciationStartYear'],
      });
    }
    if (v.funding === 'paid_in_full') {
      // Down payment is meaningless when paid outright — if sent, it must equal
      // the amount; normally omitted and the server sets paidNow = amount.
      if (v.downPayment !== undefined && Number(v.downPayment) !== amount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A purchase paid in full has no separate down payment.',
          path: ['downPayment'],
        });
      }
    } else if (v.downPayment !== undefined && Number(v.downPayment) >= amount) {
      // Financed: a down payment can't cover the whole cost (then it's paid in
      // full), so it must be strictly less than the amount.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The amount paid now can't be the whole cost — choose paid in full instead.",
        path: ['downPayment'],
      });
    }
  });

export type CapitalPurchaseCreateInput = z.infer<typeof capitalPurchaseCreateSchema>;

// A payment toward a financed purchase. amount is what they paid; interest is
// the portion that's a finance charge (optional, defaults to 0) and can't exceed
// the payment.
export const loanPaymentSchema = z
  .object({
    amount: moneyString,
    interest: moneyString.optional().default('0'),
    // Which account the payment went out of. Omitted → primary.
    paymentAccountId: z.string().uuid().optional(),
    paidOn: isoDateString,
  })
  .superRefine((v, ctx) => {
    if (!(Number(v.amount) > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter how much you paid.',
        path: ['amount'],
      });
    }
    if (Number(v.interest) > Number(v.amount)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Interest can't be more than the payment.",
        path: ['interest'],
      });
    }
  });

export type LoanPaymentInput = z.infer<typeof loanPaymentSchema>;
