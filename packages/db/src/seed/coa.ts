import { and, eq, inArray } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Database, Transaction } from '../client.js';
import { chartOfAccounts } from '../schema/chart_of_accounts.js';
import { journalLines } from '../schema/journal_lines.js';
import { C_CORP_OVERLAY } from './coa-c-corp.js';
import { PARTNERSHIP_OVERLAY } from './coa-partnership.js';
import { S_CORP_OVERLAY } from './coa-s-corp.js';
import { SOLE_PROP_OVERLAY } from './coa-sole-prop.js';

// The chart of accounts, built per business type (TMC-124).
//
// Every entity type shares the same *skeleton* — a landscaper's cash, receivables,
// truck, and supplies are the same accounts whether they file as a sole prop or an
// S-corp. What actually differs is (a) how the owner's stake is described, (b) a
// handful of accounts only some entities need, and (c) which tax line each account
// rolls up to. So the chart is one shared base plus a per-entity overlay, rather
// than four hand-maintained copies that would drift the moment an account is added.
//
// Each overlay lives in its own file named for the return that entity files, so it
// can be read side-by-side with the real IRS form:
//
//   coa-sole-prop.ts     Schedule C (Form 1040)   sole_prop + llc_single_member
//   coa-partnership.ts   Form 1065                partnership
//   coa-s-corp.ts        Form 1120-S              s_corp
//   coa-c-corp.ts        Form 1120                c_corp
//
// THE CODE NUMBERS ARE STABLE ACROSS ALL FOUR, DELIBERATELY. apps/api/src/lib/
// ledger.ts posts by literal code (COA_CASH = '1000', COA_OWNERS_DRAW = '3100',
// …), so an entity that renumbered would silently post to the wrong account. An
// entity that renames 3100 to "Shareholder Distributions" keeps posting there and
// everything downstream — reports, the ledger portal, owner-money events — works
// untouched. Renaming is safe; renumbering is not.
//
// A consequence worth knowing: the expense codes are ordered to match Schedule C
// Part II line order (reports sort by code), so a corporation's chart prints in
// Schedule C order rather than its own form's order. That's the price of one
// stable numbering, and it's the right trade — the tax_mapping carries the real
// line, and a consistent chart across entity types means a business that
// incorporates doesn't watch its account numbers shuffle.
//
// Intentionally omitted from every chart (unchanged from the original sole-prop
// seed — these are product decisions, not entity-specific ones):
// - COGS: service-led trades pass materials through as a billed line item;
//   treating materials cost as Supplies is the Wave default for sole props.
//   Every one of 1065 / 1120-S / 1120 has a COGS line that stays blank as a
//   result, exactly as Schedule C's does today.
// - Bad debts: the 1065/1120/1120-S line exists but nothing writes off a
//   receivable yet.
// - Health insurance / SEP IRA / pension: on Schedule 1 of the 1040, not
//   Schedule C. The corporate forms do have pension/benefit lines; they stay
//   blank until there's a payroll workflow to fill them.
// - Separate Cash accounts per bank/processor: one Cash is fine for now.

export type CoaAccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type CoaNormalBalance = 'debit' | 'credit';

export type CoaSeed = {
  code: string;
  name: string;
  accountType: CoaAccountType;
  normalBalance: CoaNormalBalance;
  taxMapping: string | null;
};

// An account before the entity overlay decides what tax line it lands on.
export type CoaAccount = Omit<CoaSeed, 'taxMapping'>;

// What one business type changes about the shared chart.
export type CoaOverlay = {
  // The federal return this entity files, in the words the IRS uses. Surfaced to
  // the user wherever we have to explain why a Schedule C worksheet isn't theirs.
  taxForm: string;
  // Shared accounts this entity calls something else. Keyed by code — the code
  // never moves, only the label.
  rename?: Readonly<Record<string, string>>;
  // Accounts only this entity needs (officer compensation, retained earnings…).
  extra?: readonly CoaAccount[];
  // code → the line on THIS entity's return. A code absent from the map gets a
  // null tax_mapping, which is how balance-sheet accounts and anything the form
  // has no line for are represented.
  taxMapping: Readonly<Record<string, string>>;
};

// The shared skeleton. Names here are the sole-proprietor wording — the plainest
// version, and the one the overlays diverge from. Tax mapping is deliberately
// absent: it belongs to the entity, not the account.
const BASE_COA: readonly CoaAccount[] = [
  // Assets
  { code: '1000', name: 'Cash', accountType: 'asset', normalBalance: 'debit' },
  { code: '1200', name: 'Accounts Receivable', accountType: 'asset', normalBalance: 'debit' },
  // Durable gear the business owns and uses for years — a mower, trailer, truck.
  // Posted to by the "log a big purchase" flow (a capital asset, carried here at
  // cost rather than expensed on day one). Gross cost lives here; the wear-down
  // nets against it via Accumulated Depreciation (1900). The user never sees
  // "fixed asset" — that's internal; they see "things you bought".
  { code: '1500', name: 'Vehicles & Equipment', accountType: 'asset', normalBalance: 'debit' },
  // Accumulated Depreciation — a CONTRA-asset: it carries a credit balance
  // (it nets against gross fixed assets on the balance sheet). It is an asset
  // by classification, but we seed normal_balance as 'debit', NOT 'credit',
  // on purpose. The balance-sheet / P&L code (routes/reports.ts) nets every
  // account in its normal_balance direction; with 'debit' a credit posting to
  // this account comes out NEGATIVE, so it reduces total assets and
  // Assets = Liabilities + Equity still holds with no contra-account special-
  // casing. normal_balance is a display-direction hint only — the GL / trial-
  // balance export reads the actual posting `side`, so the export is unaffected
  // and an accountant still sees the real credit balance.
  { code: '1900', name: 'Accumulated Depreciation', accountType: 'asset', normalBalance: 'debit' },

  // Liabilities
  { code: '2000', name: 'Accounts Payable', accountType: 'liability', normalBalance: 'credit' },
  { code: '2200', name: 'Sales Tax Payable', accountType: 'liability', normalBalance: 'credit' },
  // What the business still owes on financed purchases — a mower bought on
  // payments. The remainder after any down payment lands here at purchase; each
  // payment pays it down. Distinct from Accounts Payable (2000, short-term
  // supplier credit). Internal name "Loans Payable"; the user sees "you still
  // owe $X on the mower".
  { code: '2700', name: 'Loans Payable', accountType: 'liability', normalBalance: 'credit' },

  // Equity. These two codes are the load-bearing ones: owner money events post
  // a contribution to 3000 and a withdrawal to 3100 by code, for every entity
  // type. What the money is *called* is entity-specific — a sole proprietor
  // takes a draw, a shareholder takes a distribution, a C-corp shareholder takes
  // a dividend — so the overlays rename them and the posting logic never knows.
  { code: '3000', name: "Owner's Equity", accountType: 'equity', normalBalance: 'credit' },
  { code: '3100', name: "Owner's Draw", accountType: 'equity', normalBalance: 'debit' },

  // Revenue — split by line type at posting time (service vs product lines).
  { code: '4000', name: 'Service Revenue', accountType: 'revenue', normalBalance: 'credit' },
  { code: '4100', name: 'Product Revenue', accountType: 'revenue', normalBalance: 'credit' },

  // Expenses — ordered to match Schedule C Part II line order (see the note at
  // the top of this file about why that ordering holds for every entity).
  { code: '6000', name: 'Advertising', accountType: 'expense', normalBalance: 'debit' },
  { code: '6100', name: 'Car & Truck Expenses', accountType: 'expense', normalBalance: 'debit' },
  { code: '6200', name: 'Commissions & Fees', accountType: 'expense', normalBalance: 'debit' },
  { code: '6300', name: 'Contract Labor', accountType: 'expense', normalBalance: 'debit' },
  // Depreciation slots between Contract Labor and Insurance so the code order
  // tracks Schedule C line order (13 sits between 11 and 15). Posted by the
  // §179 write-off, the spread-it-out path, and by hand from the ledger portal;
  // its credit leg lands on Accumulated Depreciation (1900).
  { code: '6350', name: 'Depreciation Expense', accountType: 'expense', normalBalance: 'debit' },
  { code: '6400', name: 'Insurance', accountType: 'expense', normalBalance: 'debit' },
  { code: '6500', name: 'Interest Expense', accountType: 'expense', normalBalance: 'debit' },
  { code: '6600', name: 'Legal & Professional', accountType: 'expense', normalBalance: 'debit' },
  { code: '6700', name: 'Office Expense', accountType: 'expense', normalBalance: 'debit' },
  {
    code: '6800',
    name: 'Rent — Vehicles & Equipment',
    accountType: 'expense',
    normalBalance: 'debit',
  },
  {
    code: '6850',
    name: 'Rent — Other Business Property',
    accountType: 'expense',
    normalBalance: 'debit',
  },
  { code: '6900', name: 'Repairs & Maintenance', accountType: 'expense', normalBalance: 'debit' },
  { code: '7000', name: 'Supplies', accountType: 'expense', normalBalance: 'debit' },
  { code: '7100', name: 'Taxes & Licenses', accountType: 'expense', normalBalance: 'debit' },
  { code: '7200', name: 'Travel', accountType: 'expense', normalBalance: 'debit' },
  { code: '7300', name: 'Meals', accountType: 'expense', normalBalance: 'debit' },
  { code: '7400', name: 'Utilities', accountType: 'expense', normalBalance: 'debit' },
  { code: '7500', name: 'Wages', accountType: 'expense', normalBalance: 'debit' },
  { code: '7900', name: 'Other Expenses', accountType: 'expense', normalBalance: 'debit' },
  // Stripe keeps its cut before depositing, so a card payment debits Cash for
  // the net and this for the fee, against the customer's gross.
  {
    code: '7950',
    name: 'Merchant Processing Fees',
    accountType: 'expense',
    normalBalance: 'debit',
  },
];

// A sole proprietor and a single-member LLC are both disregarded entities that
// file Schedule C, so they share one overlay. That is not a fallback — it is the
// correct chart for both.
const OVERLAYS = {
  sole_prop: SOLE_PROP_OVERLAY,
  llc_single_member: SOLE_PROP_OVERLAY,
  partnership: PARTNERSHIP_OVERLAY,
  s_corp: S_CORP_OVERLAY,
  c_corp: C_CORP_OVERLAY,
} as const;

// Null business type means "we haven't asked yet" — the signup hook seeds a chart
// before the welcome wizard gets the operator's answer. Sole prop is the right
// provisional guess (it's the overwhelming majority and the base chart's own
// wording), and the wizard's answer runs reconcileChartOfAccounts to correct it.
export function coaOverlayFor(businessType: string | null | undefined): CoaOverlay {
  if (businessType && businessType in OVERLAYS) {
    return OVERLAYS[businessType as keyof typeof OVERLAYS];
  }
  return SOLE_PROP_OVERLAY;
}

// The full chart for a business type, in code order.
export function chartForBusinessType(businessType: string | null | undefined): readonly CoaSeed[] {
  const overlay = coaOverlayFor(businessType);
  return [...BASE_COA, ...(overlay.extra ?? [])]
    .map((account) => ({
      ...account,
      name: overlay.rename?.[account.code] ?? account.name,
      taxMapping: overlay.taxMapping[account.code] ?? null,
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

// The sole-prop chart, kept as a named export because it's the fixture every
// ledger/RLS test seeds against.
export const SOLE_PROP_COA: readonly CoaSeed[] = chartForBusinessType('sole_prop');

// Inserts a company's chart at creation. Called from the signup hook inside the
// same tx that seeds account + company + membership (business type still null
// there — see coaOverlayFor), and from the company-create route, which does know
// the type the operator picked.
//
// Idempotent at the unique-index level — (company_id, code) is unique so a second
// call no-ops via `onConflictDoNothing`. The application path doesn't double-call,
// but a partial-failure replay shouldn't double-seed either.
export async function seedChartOfAccounts(
  tx: Database | Transaction,
  args: { accountId: string; companyId: string; businessType?: string | null },
): Promise<void> {
  const rows = chartForBusinessType(args.businessType).map((seed) => ({
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

export type CoaReconcileResult = {
  // Accounts the new entity type needs that weren't there before.
  added: string[];
  // Accounts relabelled to the new entity's wording.
  renamed: string[];
  // Accounts the new entity would relabel but that already carry postings, so
  // they keep the name their history was recorded under. Reported rather than
  // swallowed: the caller audits it, and it's the one place a switched company's
  // chart doesn't fully match its entity type.
  keptName: string[];
  // Accounts the old entity needed and the new one doesn't, switched off (never
  // deleted). Only ever unposted ones — an account with history stays visible.
  deactivated: string[];
};

// Moves an existing company's chart onto a different business type, in place.
//
// Runs on two paths: the welcome wizard answering "what kind of business is
// this?" for a freshly-seeded company (the common case — nothing is posted yet,
// so the chart converts cleanly), and an established business changing its type
// in settings after incorporating.
//
// The rule is that money never moves. Journal entries, amounts and dates are
// untouched; this only adds accounts, relabels ones with no history, refreshes
// which tax line each account rolls up to, and switches off ones the new entity
// has no use for. An account that already carries postings keeps its name, so
// existing history still reads under the label it was recorded with — which does
// mean a long-running sole proprietor who incorporates keeps "Owner's Draw" as
// the label on the account that now receives distributions. Correcting that
// properly means closing the old equity accounts into the new ones, which needs
// a year-end close process we don't have yet.
export async function reconcileChartOfAccounts(
  tx: Database | Transaction,
  args: { accountId: string; companyId: string; businessType: string | null },
): Promise<CoaReconcileResult> {
  const target = chartForBusinessType(args.businessType);
  const targetByCode = new Map(target.map((a) => [a.code, a]));

  const existing = await tx
    .select({
      id: chartOfAccounts.id,
      code: chartOfAccounts.code,
      name: chartOfAccounts.name,
      taxMapping: chartOfAccounts.taxMapping,
      isActive: chartOfAccounts.isActive,
    })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.accountId, args.accountId),
        eq(chartOfAccounts.companyId, args.companyId),
      ),
    );
  const existingByCode = new Map(existing.map((r) => [r.code, r]));

  // Which accounts already carry history. One query over this company's lines
  // rather than a per-account existence check.
  const posted = new Set<string>();
  if (existing.length > 0) {
    const lines = await tx
      .selectDistinct({ coaAccountId: journalLines.coaAccountId })
      .from(journalLines)
      .where(
        and(
          eq(journalLines.accountId, args.accountId),
          inArray(
            journalLines.coaAccountId,
            existing.map((r) => r.id),
          ),
        ),
      );
    for (const l of lines) posted.add(l.coaAccountId);
  }

  const result: CoaReconcileResult = { added: [], renamed: [], keptName: [], deactivated: [] };
  const now = new Date();

  const toInsert = target
    .filter((a) => !existingByCode.has(a.code))
    .map((seed) => ({
      id: uuidv7(),
      accountId: args.accountId,
      companyId: args.companyId,
      code: seed.code,
      name: seed.name,
      accountType: seed.accountType,
      normalBalance: seed.normalBalance,
      taxMapping: seed.taxMapping,
    }));
  if (toInsert.length > 0) {
    await tx
      .insert(chartOfAccounts)
      .values(toInsert)
      .onConflictDoNothing({ target: [chartOfAccounts.companyId, chartOfAccounts.code] });
    result.added = toInsert.map((r) => r.code);
  }

  for (const row of existing) {
    const want = targetByCode.get(row.code);

    // Not in the new entity's chart. Switch it off so it drops out of the
    // account pickers, unless it has history worth keeping reachable.
    if (!want) {
      if (!posted.has(row.id) && row.isActive) {
        await tx
          .update(chartOfAccounts)
          .set({ isActive: false, updatedAt: now })
          .where(eq(chartOfAccounts.id, row.id));
        result.deactivated.push(row.code);
      }
      continue;
    }

    const patch: Record<string, unknown> = {};
    // tax_mapping always follows the entity — it's a pointer at a line on this
    // year's return, not a record of anything historical, and leaving a Schedule
    // C line on an S-corp's chart would be actively wrong.
    if (row.taxMapping !== want.taxMapping) patch.taxMapping = want.taxMapping;
    // The account is back in the chart after a previous switch turned it off.
    if (!row.isActive) patch.isActive = true;

    if (row.name !== want.name) {
      if (posted.has(row.id)) {
        result.keptName.push(row.code);
      } else {
        patch.name = want.name;
        result.renamed.push(row.code);
      }
    }

    if (Object.keys(patch).length > 0) {
      patch.updatedAt = now;
      await tx.update(chartOfAccounts).set(patch).where(eq(chartOfAccounts.id, row.id));
    }
  }

  return result;
}
