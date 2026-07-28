// Shared owner-money-event → list-row mapping, used by both the SSR loader and
// the `/more` proxy so appended pages match page 1 exactly. The double-entry is
// hidden: a 'contribution' reads as an "Investment" (the owner funding the
// business), a 'draw' as a "Withdrawal" (the owner paying themselves).
//
// Deliberately NOT "Money in / Money out" — the dashboard already uses those two
// phrases for all business income and expenses, which is a different thing
// entirely. Banking words instead of accounting ones: everyone has made a
// withdrawal, nobody outside accounting says "drawings".
type ApiOwnerMoneyEvent = {
  id: string;
  kind: string;
  amount: string;
  occurredOn: string;
  memo: string | null;
};

export type OwnerMoneyRow = {
  id: string;
  occurredOn: string;
  kind: string;
  kindLabel: string;
  direction: 'in' | 'out';
  amount: string;
  memo: string | null;
};

export function kindLabel(kind: string): string {
  return kind === 'contribution' ? 'Investment' : 'Withdrawal';
}

export function mapOwnerMoneyRows(events: ApiOwnerMoneyEvent[]): OwnerMoneyRow[] {
  return events.map((e) => ({
    id: e.id,
    occurredOn: e.occurredOn,
    kind: e.kind,
    kindLabel: kindLabel(e.kind),
    direction: e.kind === 'contribution' ? 'in' : 'out',
    amount: e.amount,
    memo: e.memo,
  }));
}
