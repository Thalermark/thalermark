// Shapes shared by the starting-balances component and its server helpers.
// Split out of `opening-balance.server.ts` because a component can't import a
// `.server` module — SvelteKit refuses at build time, which is the point.

export type OpeningBalanceAccount = {
  id: string;
  code: string;
  name: string;
  accountType: string;
};

export type OpeningBalanceLine = {
  coaAccountId: string;
  side: string;
  amount: string;
};

export type OpeningBalanceRecord = {
  asOfDate: string;
  shape: string;
  cash: string;
  receivables: string;
  payables: string;
};

// What `loadOpeningBalance` returns, and what <StartingBalances> needs.
export type OpeningBalanceData = {
  current: OpeningBalanceRecord | null;
  lines: OpeningBalanceLine[];
  // Empty for roles without ledger:adjust — the loader skips the fetch, and the
  // component reads that emptiness as "don't offer the full trial balance".
  accounts: OpeningBalanceAccount[];
  today: string;
};

// The action result the component renders. Both shapes fail differently: the
// three questions report per-field errors, the trial balance reports one.
export type OpeningBalanceForm = {
  values?: Record<string, unknown>;
  fieldErrors?: Record<string, string>;
  formError?: string;
  fullError?: string;
} | null;
