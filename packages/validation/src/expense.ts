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
// Cr payment. customerContactId is the job-costing link (which contact, acting
// as customer, the expense was for); carried nullable from day one for v1.x but
// MVP doesn't surface it in the form, so it's optional here.
//
// amount is a decimal string ([[architecture_money_decimal_strings]]);
// expenseDate is a bare YYYY-MM-DD calendar date matching the
// `date({ mode: 'string' })` column. merchant is free text — the single
// on-screen "Vendor" field's display name; receipt OCR writes the raw string
// with no link required. vendorContactId is the optional structured buy-from
// link (a contact, acting as vendor): nullable so the edit form can clear it
// back to free-text. The needs-review flag itself is server-managed (set when
// a receipt-backed expense has no vendor, cleared on link-or-dismiss), so it is
// not a client-supplied field. memo is the user's note.
export const expenseCreateSchema = z.object({
  companyId: z.string().uuid(),
  customerContactId: z.string().uuid().optional(),
  vendorContactId: z.string().uuid().nullable().optional(),
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

// Input schema for POST /api/expenses/categorize — the text-based category
// suggestion (AI). Stateless: there is no expense row yet, so the client sends
// the visible fields it has so far. companyId scopes the suggestion to that
// company's expense chart of accounts; accountId is inferred from rls-context.
// merchant is the one required signal; memo + amount are optional extra
// context. amount reuses the decimal-string money convention but is optional
// here because the user may ask for a suggestion before typing it.
export const expenseCategorizeSchema = z.object({
  companyId: z.string().uuid(),
  merchant: z.string().min(1).max(200),
  memo: z.string().max(5000).optional(),
  amount: moneyString.optional(),
});

export type ExpenseCategorizeInput = z.infer<typeof expenseCategorizeSchema>;

// Input schema for PUT /api/expenses/:id/allocations — job costing (TMC-174),
// "what was this for?" on a receipt. Replace-all rather than incremental: the
// set for one expense has to sum to 1, and validating that is only possible
// with the whole set in hand.
//
// invoiceId null is the SHARED answer — a deliberate "won't attribute this",
// which is different from an empty list, meaning the user never answered.
// Keeping those distinct is the point of the feature: shared is a real answer
// and nothing ever nags him to split it.
//
// share is a fraction of the expense, not money, so it survives an edit to the
// expense total. Four decimal places is plenty for an even split across a
// realistic number of jobs and keeps the sum check away from float noise.
// Since TMC-181 a row may instead name a JOB. Both null is the shared answer;
// naming both at once is rejected, because job margin rolls invoice-grain and
// job-grain costs together and a row carrying both would be counted twice.
// Defaulted rather than required so a job-only payload validates without the
// client sending an explicit invoiceId: null.
export const expenseAllocationSchema = z
  .object({
    invoiceId: z.string().uuid().nullable().default(null),
    jobId: z.string().uuid().nullable().default(null),
    share: z
      .string()
      .regex(/^\d+(\.\d{1,6})?$/, 'share must be a decimal fraction')
      .refine((s) => Number(s) > 0 && Number(s) <= 1, 'share must be in (0, 1]'),
  })
  .refine((a) => !(a.invoiceId && a.jobId), { message: 'allocation_names_both_grains' });

// Which bucket a row targets, for the duplicate check below. Namespaced so an
// invoice id and a job id can never collide, and 'shared' stays the single
// identity for the both-null row the DB's partial unique also guards.
function allocationTarget(a: { invoiceId: string | null; jobId: string | null }): string {
  if (a.jobId) return `job:${a.jobId}`;
  if (a.invoiceId) return `invoice:${a.invoiceId}`;
  return 'shared';
}

export const expenseAllocationsSchema = z
  .object({
    allocations: z.array(expenseAllocationSchema).max(50),
  })
  // An empty list clears the answer entirely (back to "never answered"), so the
  // sum only has to hold when there is something there. Tolerance absorbs an
  // even split that can't divide cleanly — 1/3 three ways is 0.999999.
  .refine(
    (v) =>
      v.allocations.length === 0 ||
      Math.abs(v.allocations.reduce((t, a) => t + Number(a.share), 0) - 1) < 0.0001,
    { message: 'shares_must_sum_to_one' },
  )
  // The DB has partial uniques for this; catching it here turns a 500 into a
  // 400 with a usable message.
  .refine((v) => new Set(v.allocations.map(allocationTarget)).size === v.allocations.length, {
    message: 'duplicate_allocation_target',
  });

export type ExpenseAllocationsInput = z.infer<typeof expenseAllocationsSchema>;
