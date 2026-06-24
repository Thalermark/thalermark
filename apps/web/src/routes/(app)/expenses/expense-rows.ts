// Shared expense → list-row mapping, used by both the SSR loader and the
// `/more` proxy so appended pages match page 1 exactly. categoryNameById maps
// a chart-of-accounts id to its "code · name" label (the categories set is
// small and bounded, so both call sites fetch it).
type ApiExpense = {
  id: string;
  expenseDate: string;
  merchant: string;
  amount: string;
  categoryAccountId: string | null;
  receiptStorageKey: string | null;
  vendorReview: string | null;
};

export type ExpenseRow = {
  id: string;
  expenseDate: string;
  merchant: string;
  amount: string;
  categoryName: string;
  hasReceipt: boolean;
  needsReview: boolean;
};

export function mapExpenseRows(
  expenses: ApiExpense[],
  categoryNameById: Map<string, string>,
): ExpenseRow[] {
  return expenses.map((e) => ({
    id: e.id,
    expenseDate: e.expenseDate,
    merchant: e.merchant,
    amount: e.amount,
    categoryName: (e.categoryAccountId && categoryNameById.get(e.categoryAccountId)) || '—',
    hasReceipt: e.receiptStorageKey != null,
    needsReview: e.vendorReview === 'needs_review',
  }));
}
