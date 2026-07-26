import { centsToMoney, toCents } from '@thalermark/validation';

// Schedule C (Form 1040) shape + the mapping from our chart of accounts onto
// it (TMC-155). Pure functions only — the SQL lives in routes/reports.ts; this
// module owns the *form*, so the line table can be reviewed against the real
// IRS form without reading query code.
//
// Why a static table rather than deriving the lines from whatever tax_mapping
// strings happen to be in the COA: the form has lines we never seed (12
// depletion, 14 employee benefits, 16a mortgage interest, 19 pension) and those
// must still render — at zero — or the export reads like a filtered P&L instead
// of a tax form. A user comparing it to the IRS PDF should find every line.
//
// Part II line numbering has been structurally stable for decades; the only
// changes in ~20 years were cosmetic (2018 TCJA dropped entertainment from 24b,
// 2019 reworded the 1099 checkboxes, 2022 repurposed 27b). Rates and thresholds
// churn annually, but those live in the tax-readiness *estimate* work, not
// here. Expect to touch this table roughly once every few years.

export type ScheduleCLine = {
  // The line number as printed on the form. String, not number: 16a/20a/24a are
  // real line ids and sorting is positional, never numeric.
  line: string;
  label: string;
  // True when we structurally cannot fill this line and the user must supply it
  // themselves. Rendered as an explicit blank — never silently omitted, because
  // an export that quietly drops lines reads as complete when it isn't.
  userSupplied?: true;
};

// Part II, Expenses — lines 8 through 27a, in form order.
export const SCHEDULE_C_PART_II: readonly ScheduleCLine[] = [
  { line: '8', label: 'Advertising' },
  // Mileage is deferred in MVP scope, so nothing posts here. Kept visible so a
  // user who drives for work knows the export isn't claiming they had no
  // vehicle expense.
  { line: '9', label: 'Car and truck expenses', userSupplied: true },
  { line: '10', label: 'Commissions and fees' },
  { line: '11', label: 'Contract labor' },
  { line: '12', label: 'Depletion' },
  { line: '13', label: 'Depreciation and section 179 expense' },
  { line: '14', label: 'Employee benefit programs' },
  { line: '15', label: 'Insurance (other than health)' },
  { line: '16a', label: 'Interest — mortgage (paid to banks, etc.)' },
  { line: '16b', label: 'Interest — other' },
  { line: '17', label: 'Legal and professional services' },
  { line: '18', label: 'Office expense' },
  { line: '19', label: 'Pension and profit-sharing plans' },
  { line: '20a', label: 'Rent or lease — vehicles, machinery, equipment' },
  { line: '20b', label: 'Rent or lease — other business property' },
  { line: '21', label: 'Repairs and maintenance' },
  { line: '22', label: 'Supplies' },
  { line: '23', label: 'Taxes and licenses' },
  { line: '24a', label: 'Travel' },
  { line: '24b', label: 'Deductible meals' },
  { line: '25', label: 'Utilities' },
  { line: '26', label: 'Wages (less employment credits)' },
  { line: '27a', label: 'Other expenses' },
];

const PART_II_LINES: ReadonlySet<string> = new Set(SCHEDULE_C_PART_II.map((l) => l.line));

// Pulls the line id out of a chart_of_accounts.tax_mapping value. The seed
// writes 'Schedule C, Line 24b'; we accept any casing/spacing around the same
// shape so a hand-edited or future-seeded account still lands. Returns null for
// null, blank, non-Schedule-C (a v1.x 1120-S seed), or an unrecognised line —
// all of which the caller must surface rather than drop.
export function parseScheduleCLine(taxMapping: string | null): string | null {
  if (!taxMapping) return null;
  const m = /schedule\s*c\s*,?\s*line\s*([0-9]{1,2}[a-z]?)/i.exec(taxMapping);
  if (!m?.[1]) return null;
  const line = m[1].toLowerCase();
  return PART_II_LINES.has(line) ? line : null;
}

// One chart-of-accounts row contributing to a line, kept alongside the rolled-up
// total so the UI can show its working ("27a Other expenses — Other Expenses
// 40.00, Merchant Processing Fees 3.44"). Without this a user who sees an
// unexpected 27a has no way to find out why.
export type ScheduleCAccount = { code: string; name: string; amount: string };

export type ScheduleCPartIIRow = ScheduleCLine & {
  amount: string;
  accounts: ScheduleCAccount[];
};

export type ExpenseAccountAmount = {
  code: string;
  name: string;
  taxMapping: string | null;
  amount: string;
};

export type PartIIRollup = {
  rows: ScheduleCPartIIRow[];
  // Expense accounts whose tax_mapping doesn't resolve to a Part II line. These
  // are still summed into totalExpenses — dropping them would make line 28
  // disagree with the P&L, which is a worse failure than showing an account we
  // can't place. The UI lists them as "review these".
  unmapped: ScheduleCAccount[];
  totalExpenses: string;
};

// Rolls per-account expense totals onto the Part II line skeleton. Multiple
// accounts can share a line — 27a carries both Other Expenses (7900) and
// Merchant Processing Fees (7950) — so this is a genuine group-by, not a
// relabel. Every line in the skeleton comes back, zero-filled, in form order.
//
// Accounts contributing 0.00 are dropped from a line's `accounts` breakdown
// (they'd be noise) but the line itself still renders.
export function rollUpPartII(accounts: ExpenseAccountAmount[]): PartIIRollup {
  const byLine = new Map<string, ScheduleCAccount[]>();
  const unmapped: ScheduleCAccount[] = [];
  let totalCents = 0;

  for (const acct of accounts) {
    const cents = toCents(acct.amount);
    totalCents += cents;
    const entry = { code: acct.code, name: acct.name, amount: acct.amount };
    const line = parseScheduleCLine(acct.taxMapping);
    if (line === null) {
      // Zero-value unmapped accounts are pure noise — an untouched custom
      // account shouldn't raise a "review this" flag.
      if (cents !== 0) unmapped.push(entry);
      continue;
    }
    if (cents === 0) continue;
    const bucket = byLine.get(line);
    if (bucket) bucket.push(entry);
    else byLine.set(line, [entry]);
  }

  const rows = SCHEDULE_C_PART_II.map((line) => {
    const contributing = byLine.get(line.line) ?? [];
    const lineCents = contributing.reduce((sum, a) => sum + toCents(a.amount), 0);
    return { ...line, amount: centsToMoney(lineCents), accounts: contributing };
  });

  return { rows, unmapped, totalExpenses: centsToMoney(totalCents) };
}

// The calendar-year window a Schedule C covers. Returns the inclusive `from` /
// `to` date strings plus the half-open [fromDate, toExclusive) instants the GL
// queries use — same upper-bound convention as the other reports.
//
// Deliberately calendar-year: every other report defaults to year-to-date, but
// a tax form is always Jan 1 – Dec 31 of a filed year. Fiscal-year filers are a
// v1.x concern and would need a company-level year-end first.
export function taxYearWindow(year: number): {
  from: string;
  to: string;
  fromDate: Date;
  toExclusive: Date;
} {
  return {
    from: `${year}-01-01`,
    to: `${year}-12-31`,
    fromDate: new Date(Date.UTC(year, 0, 1)),
    toExclusive: new Date(Date.UTC(year + 1, 0, 1)),
  };
}
