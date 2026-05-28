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
// Intentionally omitted from MVP:
// - Depreciation Expense + Accumulated Depreciation (Sch C line 13):
//   needs a fixed-asset workflow to post correctly (Dr Dep Exp / Cr
//   Acc Dep, not Cr Cash). Defer until equipment tracking lands.
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

  // Liabilities
  {
    code: '2200',
    name: 'Sales Tax Payable',
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
