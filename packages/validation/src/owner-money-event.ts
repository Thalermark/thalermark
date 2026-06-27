import { z } from 'zod';
import { isoDateString, moneyString } from './money.js';

// Owner money events — the owner moving their OWN money in or out of the
// business. The user picks a plain situation, never an accounting term:
//   'contribution' — "I put my own money in"   → Dr Cash 1000 / Cr Owner's Equity 3000
//   'draw'         — "I paid myself / took out" → Dr Owner's Draw 3100 / Cr Cash 1000
//
// The double-entry is hidden (per [[project_ledger_decision]]); the client only
// supplies the company scope + the visible fields. accountId comes from the
// rls-context middleware (x-account-id). `kind` fully determines the posting, so
// — unlike bills/expenses — there is no category or payment-account field; cash
// is always Cash (1000), the single-Cash MVP assumption. amount is a decimal
// string ([[architecture_money_decimal_strings]]); occurredOn is a bare
// YYYY-MM-DD calendar date driving the ledger posting date. memo is the user's
// note.
export const OWNER_MONEY_EVENT_KINDS = ['contribution', 'draw'] as const;
export type OwnerMoneyEventKind = (typeof OWNER_MONEY_EVENT_KINDS)[number];

export const ownerMoneyEventCreateSchema = z.object({
  companyId: z.string().uuid(),
  kind: z.enum(OWNER_MONEY_EVENT_KINDS),
  amount: moneyString,
  occurredOn: isoDateString,
  memo: z.string().max(5000).optional(),
});

export type OwnerMoneyEventCreateInput = z.infer<typeof ownerMoneyEventCreateSchema>;

// Input schema for PATCH /api/owner-money/:id. Sparse like expenseUpdateSchema /
// billUpdateSchema: the edit form may touch one field. companyId is omitted — an
// event cannot move between companies (its ledger accounts are company-scoped, so
// a move would orphan the posting). At least one field must be present. Editing
// is a full reversal of the prior posting + a fresh posting in one tx (no
// amend-in-place).
export const ownerMoneyEventUpdateSchema = ownerMoneyEventCreateSchema
  .omit({ companyId: true })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'at_least_one_field_required',
  });

export type OwnerMoneyEventUpdateInput = z.infer<typeof ownerMoneyEventUpdateSchema>;
