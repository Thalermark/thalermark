import { api } from './api';

// AI category suggestion for the expense new/edit forms. Mirrors web's two
// `suggest` server actions (apps/web/.../expenses/{new,[id]/edit}): given the
// typed merchant (+ optional memo/amount) the fast model picks a category from
// the company's expense COA. The AI never writes the ledger — the caller seeds
// the picker and the user confirms on save. Opt-in: the endpoint 503s
// (`ai_not_configured`) when no LLM is configured, which we surface as a soft,
// non-blocking notice. Unlike `/api/invitations`, the categorize route is
// reachable through the typed hc client (web calls it the same way), so no raw
// fetch is needed.

// A clean 2-dp decimal — so we only hand the categorizer an amount its money
// schema accepts. A half-typed amount is dropped, not 400'd; merchant alone is
// enough signal.
const CLEAN_AMOUNT = /^\d+(\.\d{1,2})?$/;

export type SuggestResult =
  | { kind: 'applied'; categoryAccountId: string }
  | { kind: 'notice'; text: string }
  | { kind: 'error'; text: string };

export async function suggestCategory(input: {
  companyId: string;
  merchant: string;
  memo?: string;
  amount?: string;
}): Promise<SuggestResult> {
  const merchant = input.merchant.trim();
  if (merchant === '') {
    return { kind: 'error', text: 'Enter a merchant first, then suggest a category.' };
  }
  const amount = input.amount?.trim();
  const memo = input.memo?.trim();
  try {
    const res = await api.api.expenses.categorize.$post({
      json: {
        companyId: input.companyId,
        merchant,
        memo: memo ? memo : undefined,
        amount: amount && CLEAN_AMOUNT.test(amount) ? amount : undefined,
      },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const text =
        body?.error === 'ai_not_configured'
          ? 'AI categorization is not configured on this server.'
          : 'Could not suggest a category. Pick the best fit by hand.';
      return { kind: 'error', text };
    }
    const { suggestedCategoryAccountId } = await res.json();
    if (!suggestedCategoryAccountId) {
      return { kind: 'notice', text: 'No category clearly fit — pick the best one.' };
    }
    return { kind: 'applied', categoryAccountId: suggestedCategoryAccountId };
  } catch {
    return { kind: 'error', text: 'Could not suggest a category. Pick the best fit by hand.' };
  }
}
