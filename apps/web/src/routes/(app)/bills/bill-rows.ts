// Shared bill → list-row mapping, used by both the SSR loader and the `/more`
// proxy so appended pages match page 1 exactly. categoryNameById maps a
// chart-of-accounts id to its "code · name" label. The API list already joins
// the vendor name onto each row.
type ApiBill = {
  id: string;
  vendorName: string;
  billDate: string;
  dueDate: string;
  amount: string;
  status: string;
  reference: string | null;
  categoryAccountId: string;
};

export type BillRow = {
  id: string;
  vendorName: string;
  billDate: string;
  dueDate: string;
  amount: string;
  status: string;
  reference: string | null;
  categoryName: string;
};

export function mapBillRows(bills: ApiBill[], categoryNameById: Map<string, string>): BillRow[] {
  return bills.map((b) => ({
    id: b.id,
    vendorName: b.vendorName,
    billDate: b.billDate,
    dueDate: b.dueDate,
    amount: b.amount,
    status: b.status,
    reference: b.reference,
    categoryName: categoryNameById.get(b.categoryAccountId) ?? '—',
  }));
}
