import { z } from 'zod';
import { isoDateString, moneyString } from './money.js';

// Input schema for POST /api/expenses. accountId is inferred from the
// rls-context middleware (x-account-id header); the client supplies the
// company scope, the two ledger accounts the expense posts against, and the
// visible fields.
//
// categoryAccountId / paymentAccountId are chart_of_accounts row UUIDs, not
// COA codes — the form picks them from the company's seeded chart. The API
// resolves each to its code and validates account_type (category must be an
// 'expense' account, payment an 'asset' account) before posting Dr category /
// Cr payment. customerId is carried nullable from day one for v1.x job-costing
// but MVP doesn't surface it in the form, so it's optional here.
//
// amount is a decimal string ([[architecture_money_decimal_strings]]);
// expenseDate is a bare YYYY-MM-DD calendar date matching the
// `date({ mode: 'string' })` column. merchant is free text (no vendor entity
// in MVP). memo is the user's note.
export const expenseCreateSchema = z.object({
  companyId: z.string().uuid(),
  customerId: z.string().uuid().optional(),
  categoryAccountId: z.string().uuid(),
  paymentAccountId: z.string().uuid(),
  amount: moneyString,
  expenseDate: isoDateString,
  merchant: z.string().min(1).max(200),
  memo: z.string().max(5000).optional(),
});

export type ExpenseCreateInput = z.infer<typeof expenseCreateSchema>;

// Input schema for PATCH /api/expenses/:id. Sparse on purpose (same idiom as
// companyUpdateSchema): the edit form may touch one field — fix a merchant
// typo, recategorise — without resubmitting the whole expense. companyId is
// omitted because an expense cannot move between companies (its ledger
// accounts are company-scoped, so a move would orphan the posting). At least
// one field must be present. Editing an expense is a full reversal of the
// prior journal entry + a fresh posting in one tx (no amend-in-place — keeps
// the GL clean), so the API merges the patch over the current row to compute
// the new posting.
export const expenseUpdateSchema = expenseCreateSchema
  .omit({ companyId: true })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'at_least_one_field_required',
  });

export type ExpenseUpdateInput = z.infer<typeof expenseUpdateSchema>;
