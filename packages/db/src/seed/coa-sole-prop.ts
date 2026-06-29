import { v7 as uuidv7 } from 'uuid';
import type { Database, Transaction } from '../client.js';
import { chartOfAccounts } from '../schema/chart_of_accounts.js';

// Sole-proprietor chart of accounts. 4-digit codes, Schedule C tax mapping
// where applicable. Seeded by the signup hook into every company's COA at
// creation time so the ledger has somewhere to post the very first invoice.
//
// Per [[project_ledger_decision]], MVP seeds this set regardless of the
// business_type column — single-member LLCs / partnerships / S-corps /
// C-corps fall back to the sole-prop COA until v1.x adds their own seeds.
// The business_type column on companies records the operator's real
// answer so the v1.x switch is a backfill + re-seed, not a re-prompt.
//
// Expense codes ordered to match Schedule C Part II line order so the
// trial balance / GL export prints in the order an accountant expects
// to see at tax time. Tax mappings are 1040 Schedule C line numbers
// (2024 form). Internal accounts (Cash, AR, Sales Tax Payable, Owner's
// Equity, Owner's Draw) have no Schedule C line — they live on the
// balance sheet, not the P&L.
//
// Depreciation Expense (6350) + Accumulated Depreciation (1900) are seeded
// so the manual-adjustment portal ("The Ledger") can post the year-end
// depreciation figure an accountant dictates (Dr Dep Exp / Cr Acc Dep). A
// fixed-asset workflow that computes depreciation automatically is still a
// later add — this just gives the accounts somewhere to live in the interim.
//
// Intentionally omitted from MVP:
// - COGS: service-led trades pass materials through as a billed line
//   item; treating materials cost as Supplies (line 22) is the Wave
//   default for sole props. Revisit if real users want COGS.
// - Health insurance / SEP IRA / pension: these live on Schedule 1 of
//   the 1040, not Schedule C. Out of scope here.
// - Separate Cash accounts per bank/processor: one Cash is fine for
//   MVP; the in-flight "Stripe pending" state can be a v1.x add.
type CoaSeed = {
  code: string;
  name: string;
  accountType: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  normalBalance: 'debit' | 'credit';
  taxMapping: string | null;
};

export const SOLE_PROP_COA: readonly CoaSeed[] = [
  // Assets
  { code: '1000', name: 'Cash', accountType: 'asset', normalBalance: 'debit', taxMapping: null },
  {
    code: '1200',
    name: 'Accounts Receivable',
    accountType: 'asset',
    normalBalance: 'debit',
    taxMapping: null,
  },
  // Durable gear the business owns and uses for years — a mower, trailer, truck.
  // Posted to by the "log a big purchase" flow (a capital asset, carried here at
  // cost rather than expensed on day one). Gross cost lives here; the wear-down
  // nets against it via Accumulated Depreciation (1900). The user never sees
  // "fixed asset" — that's internal; they see "things you bought".
  {
    code: '1500',
    name: 'Vehicles & Equipment',
    accountType: 'asset',
    normalBalance: 'debit',
    taxMapping: null,
  },
  // Accumulated Depreciation — a CONTRA-asset: it carries a credit balance
  // (it nets against gross fixed assets on the balance sheet). It is an asset
  // by classification, but we seed normal_balance as 'debit', NOT 'credit',
  // on purpose. The balance-sheet / P&L code (routes/reports.ts) nets every
  // account in its normal_balance direction; with 'debit' a credit posting to
  // this account comes out NEGATIVE, so it reduces total assets and
  // Assets = Liabilities + Equity still holds with no contra-account special-
  // casing. normal_balance is a display-direction hint only — the GL / trial-
  // balance export reads the actual posting `side`, so the export is unaffected
  // and an accountant still sees the real credit balance. Only the manual-
  // adjustment portal ("The Ledger") posts here for now; the eventual fixed-
  // asset/depreciation workflow will post here too.
  {
    code: '1900',
    name: 'Accumulated Depreciation',
    accountType: 'asset',
    normalBalance: 'debit',
    taxMapping: null,
  },

  // Liabilities
  {
    code: '2000',
    name: 'Accounts Payable',
    accountType: 'liability',
    normalBalance: 'credit',
    taxMapping: null,
  },
  {
    code: '2200',
    name: 'Sales Tax Payable',
    accountType: 'liability',
    normalBalance: 'credit',
    taxMapping: null,
  },
  // What the business still owes on financed purchases — a mower bought on
  // payments. The remainder after any down payment lands here at purchase; each
  // payment pays it down. Distinct from Accounts Payable (2000, short-term
  // supplier credit). Internal name "Loans Payable"; the user sees "you still
  // owe $X on the mower".
  {
    code: '2700',
    name: 'Loans Payable',
    accountType: 'liability',
    normalBalance: 'credit',
    taxMapping: null,
  },

  // Equity
  {
    code: '3000',
    name: "Owner's Equity",
    accountType: 'equity',
    normalBalance: 'credit',
    taxMapping: null,
  },
  {
    code: '3100',
    name: "Owner's Draw",
    accountType: 'equity',
    normalBalance: 'debit',
    taxMapping: null,
  },

  // Revenue
  {
    code: '4000',
    name: 'Service Revenue',
    accountType: 'revenue',
    normalBalance: 'credit',
    taxMapping: 'Schedule C, Line 1',
  },
  {
    code: '4100',
    name: 'Product Revenue',
    accountType: 'revenue',
    normalBalance: 'credit',
    taxMapping: 'Schedule C, Line 1',
  },

  // Expenses — Schedule C Part II (ordered by Sch C line)
  {
    code: '6000',
    name: 'Advertising',
    accountType: 'expense',
    normalBalance: 'debit',
    taxMapping: 'Schedule C, Line 8',
  },
  {
    code: '6100',
    name: 'Car & Truck Expenses',
    accountType: 'expense',
    normalBalance: 'debit',
    taxMapping: 'Schedule C, Line 9',
  },
  {
    code: '6200',
    name: 'Commissions & Fees',
    accountType: 'expense',
    normalBalance: 'debit',
    taxMapping: 'Schedule C, Line 10',
  },
  {
    code: '6300',
    name: 'Contract Labor',
    accountType: 'expense',
    normalBalance: 'debit',
    taxMapping: 'Schedule C, Line 11',
  },
  // Depreciation is Schedule C line 13 (line 12, depletion, is unused), so its
  // code slots between Contract Labor (line 11) and Insurance (line 15) to keep
  // the code order aligned with Sch C line order — reports sort by code, so the
  // GL/trial-balance prints in the order an accountant expects. Posted by hand
  // from the manual-adjustment portal (the accountant dictates the year-end
  // figure) until a fixed-asset workflow computes it; its credit leg lands on
  // Accumulated Depreciation (1900).
  {
    code: '6350',
    name: 'Depreciation Expense',
    accountType: 'expense',
    normalBalance: 'debit',
    taxMapping: 'Schedule C, Line 13',
  },
  {
    code: '6400',
    name: 'Insurance',
    accountType: 'expense',
    normalBalance: 'debit',
    taxMapping: 'Schedule C, Line 15',
  },
  {
    code: '6500',
    name: 'Interest Expense',
    accountType: 'expense',
    normalBalance: 'debit',
    taxMapping: 'Schedule C, Line 16b',
  },
  {
    code: '6600',
    name: 'Legal & Professional',
    accountType: 'expense',
    normalBalance: 'debit',
    taxMapping: 'Schedule C, Line 17',
  },
  {
    code: '6700',
    name: 'Office Expense',
    accountType: 'expense',
    normalBalance: 'debit',
    taxMapping: 'Schedule C, Line 18',
  },
  {
    code: '6800',
    name: 'Rent — Vehicles & Equipment',
    accountType: 'expense',
    normalBalance: 'debit',
    taxMapping: 'Schedule C, Line 20a',
  },
  {
    code: '6850',
    name: 'Rent — Other Business Property',
    accountType: 'expense',
    normalBalance: 'debit',
    taxMapping: 'Schedule C, Line 20b',
  },
  {
    code: '6900',
    name: 'Repairs & Maintenance',
    accountType: 'expense',
    normalBalance: 'debit',
    taxMapping: 'Schedule C, Line 21',
  },
  {
    code: '7000',
    name: 'Supplies',
    accountType: 'expense',
    normalBalance: 'debit',
    taxMapping: 'Schedule C, Line 22',
  },
  {
    code: '7100',
    name: 'Taxes & Licenses',
    accountType: 'expense',
    normalBalance: 'debit',
    taxMapping: 'Schedule C, Line 23',
  },
  {
    code: '7200',
    name: 'Travel',
    accountType: 'expense',
    normalBalance: 'debit',
    taxMapping: 'Schedule C, Line 24a',
  },
  {
    code: '7300',
    name: 'Meals',
    accountType: 'expense',
    normalBalance: 'debit',
    taxMapping: 'Schedule C, Line 24b',
  },
  {
    code: '7400',
    name: 'Utilities',
    accountType: 'expense',
    normalBalance: 'debit',
    taxMapping: 'Schedule C, Line 25',
  },
  {
    code: '7500',
    name: 'Wages',
    accountType: 'expense',
    normalBalance: 'debit',
    taxMapping: 'Schedule C, Line 26',
  },
  {
    code: '7900',
    name: 'Other Expenses',
    accountType: 'expense',
    normalBalance: 'debit',
    taxMapping: 'Schedule C, Line 27a',
  },
  {
    code: '7950',
    name: 'Merchant Processing Fees',
    accountType: 'expense',
    normalBalance: 'debit',
    taxMapping: 'Schedule C, Line 27a',
  },
];

// Inserts the sole-prop COA for a freshly-created company. Called from the
// signup hook inside the same tx that seeds account + company + membership,
// and from the (future L3) company-create wizard.
//
// Idempotent at the unique-index level — (company_id, code) is unique so a
// second call no-ops via `onConflictDoNothing`. The application path doesn't
// double-call, but a partial-failure replay shouldn't double-seed either.
export async function seedChartOfAccounts(
  tx: Database | Transaction,
  args: { accountId: string; companyId: string },
): Promise<void> {
  const rows = SOLE_PROP_COA.map((seed) => ({
    id: uuidv7(),
    accountId: args.accountId,
    companyId: args.companyId,
    code: seed.code,
    name: seed.name,
    accountType: seed.accountType,
    normalBalance: seed.normalBalance,
    taxMapping: seed.taxMapping,
  }));
  await tx
    .insert(chartOfAccounts)
    .values(rows)
    .onConflictDoNothing({
      target: [chartOfAccounts.companyId, chartOfAccounts.code],
    });
}
