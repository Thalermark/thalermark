// Shared capital-purchase → list-row mapping, used by both the SSR loader and
// the `/more` proxy so appended pages match page 1. Plain language: a financed
// purchase with a balance still owed reads as "you still owe $X"; once it's paid
// off (or was paid in full) it reads as settled. No accounting terms.

type ApiPurchase = {
  id: string;
  description: string;
  amount: string;
  purchaseDate: string;
  funding: string;
  owing: string;
  vendorName: string | null;
};

export type PurchaseRow = {
  id: string;
  description: string;
  amount: string;
  purchaseDate: string;
  financed: boolean;
  owing: string;
  stillOwes: boolean;
  vendorName: string | null;
};

export function mapPurchaseRows(purchases: ApiPurchase[]): PurchaseRow[] {
  return purchases.map((p) => ({
    id: p.id,
    description: p.description,
    amount: p.amount,
    purchaseDate: p.purchaseDate,
    financed: p.funding === 'financed',
    owing: p.owing,
    stillOwes: Number(p.owing) > 0,
    vendorName: p.vendorName,
  }));
}
