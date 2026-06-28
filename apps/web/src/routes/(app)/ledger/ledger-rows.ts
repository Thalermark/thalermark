// Shared shaping for the manual-journal-entry list (page 1 load + the
// load-more proxy), so both render identical rows. The API returns each entry
// with its effective date, memo, magnitude (debit total) and a reversed flag;
// the row just trims posted_at to its calendar date.

export type LedgerListEntry = {
  id: string;
  postedAt: string;
  memo: string | null;
  amount: string;
  reversed: boolean;
};

export type LedgerRow = {
  id: string;
  date: string;
  memo: string | null;
  amount: string;
  reversed: boolean;
};

export function mapLedgerRows(entries: LedgerListEntry[]): LedgerRow[] {
  return entries.map((e) => ({
    id: e.id,
    date: e.postedAt.slice(0, 10),
    memo: e.memo,
    amount: e.amount,
    reversed: e.reversed,
  }));
}
