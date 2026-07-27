import { centsToMoney, toCents } from '@thalermark/validation';

// The four federal returns this product's charts of accounts are mapped onto,
// and the machinery that rolls a company's expense accounts onto whichever one
// it files (TMC-155 for Schedule C, TMC-162 for the other three). Pure functions
// only — the SQL lives in routes/reports.ts; this module owns the *forms*, so
// each line table can be reviewed against the real IRS PDF without reading query
// code.
//
// Why static tables rather than deriving lines from whatever tax_mapping strings
// happen to be in the COA: every form has lines we never seed (Schedule C's 12
// depletion, the 1065's 12 bad debts, the 1120's 19 charitable contributions)
// and those must still render — at zero — or the export reads like a filtered
// P&L instead of a tax form. A user comparing it to the IRS PDF should find
// every line, in order, with the numbering intact.
//
// Line numbering on all four has been structurally stable for years; the only
// churn in the last decade was TCJA (2018) dropping entertainment from Schedule
// C 24b and blanking Form 1120 line 25. Rates and thresholds move annually but
// those live in the tax-readiness *estimate* work, not here. Expect to touch
// these tables roughly once every few years.

export type TaxFormCode = 'schedule_c' | '1065' | '1120s' | '1120';

// What the endpoint puts on a line.
//
//   mapped          — summed from chart_of_accounts.tax_mapping
//   blank           — nothing can fill it; renders null, never 0.00, because a
//                     silent zero reads as "you had none of this"
//   zero            — a real line with no data model behind it; renders 0.00 so
//                     the form reads whole rather than abridged
//   lineNet         — other lines netted together (see netOf)
//   the rest        — computed by the endpoint from gross receipts and the
//                     deduction rollup
//
// Orthogonal to the `userSupplied` flag below: Schedule C line 9 is 'mapped'
// AND user-supplied — we know the direct vehicle costs posted to 6100, and the
// user still has to add mileage we don't track.
export type LineRole =
  | 'mapped'
  | 'blank'
  | 'zero'
  | 'lineNet'
  | 'grossReceipts'
  | 'returns'
  | 'netReceipts'
  | 'cogs'
  | 'grossProfit'
  | 'totalIncome'
  | 'totalDeductions'
  | 'netIncome';

export type TaxLine = {
  // The line number as printed on the form. String, not number: 1a/16a/24b/29c
  // are real line ids and ordering is positional, never numeric.
  line: string;
  label: string;
  role: LineRole;
  // The user has to put something here that we structurally cannot know. Shown
  // as an explicit "you must supply this" — never silently omitted, because an
  // export that quietly drops lines reads as complete when it isn't. Independent
  // of role: a line can be part-filled from the books and still need the user's
  // half (Schedule C line 9, direct vehicle costs plus untracked mileage).
  //
  // Wire-compatible with the shipped Schedule C response, where clients already
  // read this field.
  userSupplied?: true;
  // The catch-all "other deductions" line. More than half of every chart lands
  // here on the corporate and partnership forms, and the IRS requires an
  // itemised statement filed alongside — so the UI renders this line's accounts
  // expanded, as the attachment, rather than behind a disclosure.
  itemized?: true;
  // Renders on the form but is NOT part of total deductions. Exists for one
  // line: Form 1120 line 31, total tax. Income tax is not a deductible expense
  // on the corporation's own return, and 7800 Income Tax Expense is a real
  // expense account that would otherwise flow into the deductions total and
  // understate taxable income by exactly the tax.
  excludeFromTotal?: true;
  // An a/b/c group where only the final balance carries into the column that
  // sums to total deductions — the 1065's 16a/16b feeding 16c, the 1120's
  // 29a/29b feeding 29c. The IRS form puts these in a narrower left-hand column
  // for exactly that reason; the UI indents them so a reader adding up the
  // right-hand column doesn't double-count depreciation.
  subLine?: true;
  // Which lines a 'lineNet' line is composed of. `minus` entries are subtracted
  // — 1065 line 16c is depreciation (16a) LESS the part reported on Form 1125-A
  // (16b), and encoding that as a sum would quietly become wrong the day 16b
  // gets a data model.
  netOf?: { plus: readonly string[]; minus: readonly string[] };
};

export type TaxFormDef = {
  code: TaxFormCode;
  // The form's name in the words the IRS uses; also what the seeds write as the
  // tax_mapping prefix (see MAPPING_PREFIXES).
  name: string;
  // Income section — Schedule C Part I and its analogue on the other three.
  income: readonly TaxLine[];
  // Deductions section, in form order, through to the form's bottom line.
  deductions: readonly TaxLine[];
};

// --- Schedule C (Form 1040) ------------------------------------------------
// Profit or Loss From Business. Filed by a sole proprietor and by a
// single-member LLC (a disregarded entity, so it files the owner's form).
//
// The odd one out of the four: 23 distinct Part II lines with a genuine spread
// across them, where the other three forms funnel most of a chart onto one
// catch-all. The chart of accounts was originally laid out in this form's line
// order for exactly that reason.

const SCHEDULE_C: TaxFormDef = {
  code: 'schedule_c',
  name: 'Schedule C (Form 1040)',
  income: [
    { line: '1', label: 'Gross receipts or sales', role: 'grossReceipts' },
    { line: '2', label: 'Returns and allowances', role: 'returns' },
    { line: '3', label: 'Subtract line 2 from line 1', role: 'netReceipts' },
    { line: '4', label: 'Cost of goods sold (from line 42)', role: 'cogs' },
    { line: '5', label: 'Gross profit', role: 'grossProfit' },
    { line: '6', label: 'Other income', role: 'zero' },
    { line: '7', label: 'Gross income', role: 'totalIncome' },
  ],
  deductions: [
    { line: '8', label: 'Advertising', role: 'mapped' },
    // Account 6100 posts direct vehicle costs here, but mileage is deferred in
    // MVP scope — so this line is real AND incomplete. Flagged so a user who
    // drives for work knows the figure isn't claiming to be their whole vehicle
    // expense.
    { line: '9', label: 'Car and truck expenses', role: 'mapped', userSupplied: true },
    { line: '10', label: 'Commissions and fees', role: 'mapped' },
    { line: '11', label: 'Contract labor', role: 'mapped' },
    { line: '12', label: 'Depletion', role: 'mapped' },
    { line: '13', label: 'Depreciation and section 179 expense', role: 'mapped' },
    { line: '14', label: 'Employee benefit programs', role: 'mapped' },
    { line: '15', label: 'Insurance (other than health)', role: 'mapped' },
    { line: '16a', label: 'Interest — mortgage (paid to banks, etc.)', role: 'mapped' },
    { line: '16b', label: 'Interest — other', role: 'mapped' },
    { line: '17', label: 'Legal and professional services', role: 'mapped' },
    { line: '18', label: 'Office expense', role: 'mapped' },
    { line: '19', label: 'Pension and profit-sharing plans', role: 'mapped' },
    { line: '20a', label: 'Rent or lease — vehicles, machinery, equipment', role: 'mapped' },
    { line: '20b', label: 'Rent or lease — other business property', role: 'mapped' },
    { line: '21', label: 'Repairs and maintenance', role: 'mapped' },
    { line: '22', label: 'Supplies', role: 'mapped' },
    { line: '23', label: 'Taxes and licenses', role: 'mapped' },
    { line: '24a', label: 'Travel', role: 'mapped' },
    { line: '24b', label: 'Deductible meals', role: 'mapped' },
    { line: '25', label: 'Utilities', role: 'mapped' },
    { line: '26', label: 'Wages (less employment credits)', role: 'mapped' },
    { line: '27a', label: 'Other expenses', role: 'mapped', itemized: true },
    { line: '28', label: 'Total expenses', role: 'totalDeductions' },
    { line: '29', label: 'Tentative profit or loss', role: 'netIncome' },
    {
      line: '30',
      label: 'Expenses for business use of your home',
      role: 'blank',
      userSupplied: true,
    },
    // Equals line 29: line 30 is user-supplied, so we cannot subtract it. The UI
    // has to say so — same treatment as Form 1120's 29c/30 pair below.
    { line: '31', label: 'Net profit or loss', role: 'netIncome' },
  ],
};

// --- Form 1065 -------------------------------------------------------------
// U.S. Return of Partnership Income. Filed by a general partnership and by a
// multi-member LLC, which defaults to partnership taxation.
//
// Page 1 only. Schedules K and K-1 are deliberately out of scope: a K-1 comes
// from the partnership agreement's allocation percentages, which these books
// don't hold — partner capital is pooled by design (see coa-partnership.ts).
//
// 13 of the 23 mapped accounts land on line 20, so the itemised statement
// attached to that line is the real output of this worksheet.

const FORM_1065: TaxFormDef = {
  code: '1065',
  name: 'Form 1065',
  income: [
    { line: '1a', label: 'Gross receipts or sales', role: 'grossReceipts' },
    { line: '1b', label: 'Returns and allowances', role: 'returns' },
    { line: '1c', label: 'Balance', role: 'netReceipts' },
    { line: '2', label: 'Cost of goods sold (Form 1125-A)', role: 'cogs' },
    { line: '3', label: 'Gross profit', role: 'grossProfit' },
    {
      line: '4',
      label: 'Ordinary income (loss) from other partnerships, estates, and trusts',
      role: 'zero',
    },
    { line: '5', label: 'Net farm profit (loss)', role: 'zero' },
    { line: '6', label: 'Net gain (loss) from Form 4797', role: 'zero' },
    { line: '7', label: 'Other income (loss)', role: 'zero' },
    { line: '8', label: 'Total income (loss)', role: 'totalIncome' },
  ],
  deductions: [
    { line: '9', label: 'Salaries and wages (other than to partners)', role: 'mapped' },
    { line: '10', label: 'Guaranteed payments to partners', role: 'mapped' },
    { line: '11', label: 'Repairs and maintenance', role: 'mapped' },
    { line: '12', label: 'Bad debts', role: 'mapped' },
    { line: '13', label: 'Rent', role: 'mapped' },
    { line: '14', label: 'Taxes and licenses', role: 'mapped' },
    { line: '15', label: 'Interest', role: 'mapped' },
    { line: '16a', label: 'Depreciation', role: 'mapped', subLine: true },
    {
      line: '16b',
      label: 'Less depreciation reported on Form 1125-A and elsewhere',
      role: 'zero',
      subLine: true,
    },
    {
      line: '16c',
      label: 'Balance',
      role: 'lineNet',
      netOf: { plus: ['16a'], minus: ['16b'] },
    },
    { line: '17', label: 'Depletion (do not deduct oil and gas depletion)', role: 'mapped' },
    { line: '18', label: 'Retirement plans, etc.', role: 'mapped' },
    { line: '19', label: 'Employee benefit programs', role: 'mapped' },
    { line: '20', label: 'Other deductions (attach statement)', role: 'mapped', itemized: true },
    { line: '21', label: 'Total deductions', role: 'totalDeductions' },
    { line: '22', label: 'Ordinary business income (loss)', role: 'netIncome' },
  ],
};

// --- Form 1120-S -----------------------------------------------------------
// U.S. Income Tax Return for an S Corporation.
//
// Officer compensation sits on line 7, deliberately apart from everyone else's
// wages on line 8, because the IRS watches that ratio — an S-corp owner who
// works in the business must take a reasonable salary. Account 7450 already
// exists and maps here; nothing posts to it until payroll (TMC-161) lands, so
// the line renders at zero. That's correct under the render-every-line rule, and
// it's why this worksheet doesn't wait on payroll.
//
// NOTE the line numbers here differ from Form 1120's throughout — 19 vs 26 for
// other deductions, 7/8 vs 12/13 for compensation. See parseTaxMapping.

const FORM_1120S: TaxFormDef = {
  code: '1120s',
  name: 'Form 1120-S',
  income: [
    { line: '1a', label: 'Gross receipts or sales', role: 'grossReceipts' },
    { line: '1b', label: 'Returns and allowances', role: 'returns' },
    { line: '1c', label: 'Balance', role: 'netReceipts' },
    { line: '2', label: 'Cost of goods sold (Form 1125-A)', role: 'cogs' },
    { line: '3', label: 'Gross profit', role: 'grossProfit' },
    { line: '4', label: 'Net gain (loss) from Form 4797', role: 'zero' },
    { line: '5', label: 'Other income (loss)', role: 'zero' },
    { line: '6', label: 'Total income (loss)', role: 'totalIncome' },
  ],
  deductions: [
    { line: '7', label: 'Compensation of officers', role: 'mapped' },
    { line: '8', label: 'Salaries and wages (less employment credits)', role: 'mapped' },
    { line: '9', label: 'Repairs and maintenance', role: 'mapped' },
    { line: '10', label: 'Bad debts', role: 'mapped' },
    { line: '11', label: 'Rents', role: 'mapped' },
    { line: '12', label: 'Taxes and licenses', role: 'mapped' },
    { line: '13', label: 'Interest', role: 'mapped' },
    {
      line: '14',
      label: 'Depreciation not claimed on Form 1125-A or elsewhere',
      role: 'mapped',
    },
    { line: '15', label: 'Depletion (do not deduct oil and gas depletion)', role: 'mapped' },
    { line: '16', label: 'Advertising', role: 'mapped' },
    { line: '17', label: 'Pension, profit-sharing, etc., plans', role: 'mapped' },
    { line: '18', label: 'Employee benefit programs', role: 'mapped' },
    { line: '19', label: 'Other deductions (attach statement)', role: 'mapped', itemized: true },
    { line: '20', label: 'Total deductions', role: 'totalDeductions' },
    { line: '21', label: 'Ordinary business income (loss)', role: 'netIncome' },
  ],
};

// --- Form 1120 -------------------------------------------------------------
// U.S. Corporation Income Tax Return.
//
// The only entity here that isn't a pass-through: a C corporation pays income
// tax itself, which is why line 31 exists on this form and nowhere else, and why
// it carries excludeFromTotal.
//
// Line 25 is blank on the form ("Reserved for future use") since TCJA repealed
// the domestic production activities deduction for tax years beginning after
// 2017. Rendered anyway so the numbering reads continuously against the PDF.
//
// Careful: Form 1120 has its own internal "Schedule C" (dividends and special
// deductions) which lines 4 and 29b reference. That is NOT Schedule C (Form
// 1040). Nothing seeds a mapping to it, and parseTaxMapping would resolve such a
// string to the 1040 form and then fail the caller's form check — landing the
// account in "review these", which is the safe outcome.

const FORM_1120: TaxFormDef = {
  code: '1120',
  name: 'Form 1120',
  income: [
    { line: '1a', label: 'Gross receipts or sales', role: 'grossReceipts' },
    { line: '1b', label: 'Returns and allowances', role: 'returns' },
    { line: '1c', label: 'Balance', role: 'netReceipts' },
    { line: '2', label: 'Cost of goods sold (Form 1125-A)', role: 'cogs' },
    { line: '3', label: 'Gross profit', role: 'grossProfit' },
    { line: '4', label: 'Dividends and inclusions', role: 'zero' },
    { line: '5', label: 'Interest', role: 'zero' },
    { line: '6', label: 'Gross rents', role: 'zero' },
    { line: '7', label: 'Gross royalties', role: 'zero' },
    { line: '8', label: 'Capital gain net income', role: 'zero' },
    { line: '9', label: 'Net gain or (loss) from Form 4797', role: 'zero' },
    { line: '10', label: 'Other income', role: 'zero' },
    { line: '11', label: 'Total income', role: 'totalIncome' },
  ],
  deductions: [
    { line: '12', label: 'Compensation of officers', role: 'mapped' },
    { line: '13', label: 'Salaries and wages (less employment credits)', role: 'mapped' },
    { line: '14', label: 'Repairs and maintenance', role: 'mapped' },
    { line: '15', label: 'Bad debts', role: 'mapped' },
    { line: '16', label: 'Rents', role: 'mapped' },
    { line: '17', label: 'Taxes and licenses', role: 'mapped' },
    { line: '18', label: 'Interest', role: 'mapped' },
    { line: '19', label: 'Charitable contributions', role: 'mapped' },
    {
      line: '20',
      label: 'Depreciation from Form 4562 not claimed on Form 1125-A or elsewhere',
      role: 'mapped',
    },
    { line: '21', label: 'Depletion', role: 'mapped' },
    { line: '22', label: 'Advertising', role: 'mapped' },
    { line: '23', label: 'Pension, profit-sharing, etc., plans', role: 'mapped' },
    { line: '24', label: 'Employee benefit programs', role: 'mapped' },
    { line: '25', label: 'Reserved for future use', role: 'zero' },
    { line: '26', label: 'Other deductions (attach statement)', role: 'mapped', itemized: true },
    { line: '27', label: 'Total deductions', role: 'totalDeductions' },
    {
      line: '28',
      label: 'Taxable income before net operating loss and special deductions',
      role: 'netIncome',
    },
    {
      line: '29a',
      label: 'Net operating loss deduction',
      role: 'blank',
      userSupplied: true,
      subLine: true,
    },
    { line: '29b', label: 'Special deductions', role: 'blank', userSupplied: true, subLine: true },
    // Not a lineNet: both inputs are user-supplied, so this can only be blank
    // too. Summing unknowns as zero would print a confident 0.00.
    { line: '29c', label: 'Add lines 29a and 29b', role: 'blank', userSupplied: true },
    // Equals line 28: 29c is user-supplied so we cannot subtract it, exactly as
    // Schedule C's 31 cannot subtract its 30. The UI has to say so.
    { line: '30', label: 'Taxable income', role: 'netIncome' },
    // Reported after taxable income, not deducted from it.
    { line: '31', label: 'Total tax', role: 'mapped', excludeFromTotal: true },
  ],
};

export const TAX_FORMS: Readonly<Record<TaxFormCode, TaxFormDef>> = {
  schedule_c: SCHEDULE_C,
  '1065': FORM_1065,
  '1120s': FORM_1120S,
  '1120': FORM_1120,
};

// Which return each business type files. Mirrors TAX_FORM_BY_BUSINESS_TYPE in
// packages/validation (which carries the display names for the clients) and the
// `taxForm` on each COA overlay in packages/db.
//
// Null — business type not captured yet — is Schedule C: the chart seeded
// provisionally before onboarding asks is the sole-prop one, so the worksheet
// matches the accounts that actually exist. Same convention as filesScheduleC.
export function taxFormFor(businessType: string | null | undefined): TaxFormDef {
  switch (businessType) {
    case 'partnership':
      return FORM_1065;
    case 's_corp':
      return FORM_1120S;
    case 'c_corp':
      return FORM_1120;
    default:
      return SCHEDULE_C;
  }
}

// The tax_mapping prefix each form is seeded under, normalised (lowercased,
// runs of whitespace collapsed). Exact-match lookup on purpose.
//
// This is the ordering footgun the ticket flags, defused by construction: a
// regex alternation would have to place `form 1120-s` before `form 1120` or a
// naive `/1120/` silently matches BOTH, rolling an S-corp's accounts onto C-corp
// line numbers. Every line differs between the two forms (19 vs 26 for other
// deductions, 7/8 vs 12/13 for compensation), so that failure is silent and
// total. A map lookup can't be got wrong by reordering, and the unit test feeds
// every seeded string through to prove it.
const FORM_BY_MAPPING_PREFIX: Readonly<Record<string, TaxFormCode>> = {
  'schedule c': 'schedule_c',
  'schedule c (form 1040)': 'schedule_c',
  'form 1065': '1065',
  'form 1120-s': '1120s',
  'form 1120': '1120',
};

// Pulls the form and line id out of a chart_of_accounts.tax_mapping value. The
// seeds write 'Form 1120-S, Line 7'; we accept casing and spacing drift, and a
// missing comma, so a hand-edited account still lands. Returns null for null,
// blank, or a prefix we don't recognise — all of which the caller surfaces as
// unmapped rather than dropping.
export function parseTaxMapping(
  taxMapping: string | null,
): { form: TaxFormCode; line: string } | null {
  if (!taxMapping) return null;
  const m = /^\s*(.+?)\s*,?\s*line\s*([0-9]{1,2}[a-z]?)\s*$/i.exec(taxMapping);
  if (!m?.[1] || !m[2]) return null;
  const form = FORM_BY_MAPPING_PREFIX[m[1].toLowerCase().replace(/\s+/g, ' ')];
  if (!form) return null;
  return { form, line: m[2].toLowerCase() };
}

// One chart-of-accounts row contributing to a line, kept alongside the rolled-up
// total so the UI can show its working ("20 Other deductions — Office Expense
// 240.00, Supplies 1,105.60"). On the three forms whose chart mostly lands on
// one catch-all line, this list IS the itemised statement the return has to be
// filed with; without it the worksheet says "Other deductions: $47,213" and is
// useless to the person filing.
export type TaxAccount = { code: string; name: string; amount: string };

export type TaxLineRow = TaxLine & {
  // Null on a userSupplied line — an explicit blank, never 0.00, because a zero
  // reads as "you had none of this".
  amount: string | null;
  accounts: TaxAccount[];
};

export type ExpenseAccountAmount = {
  code: string;
  name: string;
  taxMapping: string | null;
  amount: string;
};

export type DeductionRollup = {
  rows: TaxLineRow[];
  // Expense accounts whose tax_mapping doesn't resolve to a line on THIS form.
  // Still summed into totalDeductions — dropping them would make the total
  // disagree with the P&L, which is a worse failure than showing an account we
  // can't place. The UI lists them as "review these".
  unmapped: TaxAccount[];
  totalDeductions: string;
  // Lines flagged excludeFromTotal, resolved separately so the endpoint can put
  // them on the form without them touching the deductions total.
  excludedTotals: Readonly<Record<string, string>>;
};

// Rolls per-account expense totals onto one form's deduction skeleton. Multiple
// accounts can share a line — Schedule C's 27a carries both Other Expenses
// (7900) and Merchant Processing Fees (7950), and the 1065's line 20 carries
// thirteen — so this is a genuine group-by, not a relabel. Every line in the
// skeleton comes back, zero-filled, in form order.
//
// An account is only placed if its mapping names THIS form. A stale mapping —
// say an account still tagged 'Form 1120-S, Line 7' inside a C-corp chart after
// a business-type change that didn't re-map cleanly — goes to `unmapped` rather
// than onto whatever line 7 happens to mean on the 1120. Landing on a plausible
// wrong line is the failure mode worth engineering against here.
//
// Accounts contributing 0.00 are dropped from a line's `accounts` breakdown
// (they'd be noise) but the line itself still renders.
export function rollUpDeductions(
  accounts: ExpenseAccountAmount[],
  form: TaxFormDef,
): DeductionRollup {
  const linesByNumber = new Map(form.deductions.map((l) => [l.line, l]));
  const byLine = new Map<string, TaxAccount[]>();
  const unmapped: TaxAccount[] = [];
  let totalCents = 0;

  for (const acct of accounts) {
    const cents = toCents(acct.amount);
    const entry = { code: acct.code, name: acct.name, amount: acct.amount };
    const parsed = parseTaxMapping(acct.taxMapping);
    const def = parsed?.form === form.code ? linesByNumber.get(parsed.line) : undefined;

    // Only 'mapped' lines can receive an account. A computed or user-supplied
    // line named by a stray mapping is not a valid target.
    if (!def || def.role !== 'mapped') {
      totalCents += cents;
      // Zero-value unmapped accounts are pure noise — an untouched custom
      // account shouldn't raise a "review this" flag.
      if (cents !== 0) unmapped.push(entry);
      continue;
    }

    // The one line that renders but isn't a deduction (Form 1120 line 31).
    if (!def.excludeFromTotal) totalCents += cents;
    if (cents === 0) continue;
    const bucket = byLine.get(def.line);
    if (bucket) bucket.push(entry);
    else byLine.set(def.line, [entry]);
  }

  const excludedTotals: Record<string, string> = {};
  const centsByLine = new Map<string, number>();
  const rows: TaxLineRow[] = form.deductions.map((line) => {
    if (line.role !== 'mapped') {
      const amount = line.role === 'blank' ? null : '0.00';
      if (amount !== null) centsByLine.set(line.line, 0);
      return { ...line, amount, accounts: [] };
    }
    const contributing = byLine.get(line.line) ?? [];
    const lineCents = contributing.reduce((sum, a) => sum + toCents(a.amount), 0);
    centsByLine.set(line.line, lineCents);
    if (line.excludeFromTotal) excludedTotals[line.line] = centsToMoney(lineCents);
    return { ...line, amount: centsToMoney(lineCents), accounts: contributing };
  });

  // Second pass — a lineNet line reads lines resolved above it. Sequential by
  // construction: every netOf on these forms points at earlier sub-lines of the
  // same group, so one pass over the already-built rows is enough.
  for (const row of rows) {
    if (row.role !== 'lineNet' || !row.netOf) continue;
    const plus = row.netOf.plus.reduce((sum, l) => sum + (centsByLine.get(l) ?? 0), 0);
    const minus = row.netOf.minus.reduce((sum, l) => sum + (centsByLine.get(l) ?? 0), 0);
    const net = plus - minus;
    centsByLine.set(row.line, net);
    row.amount = centsToMoney(net);
  }

  return { rows, unmapped, totalDeductions: centsToMoney(totalCents), excludedTotals };
}

// The calendar-year window a return covers, as plain calendar dates:
// `from`/`to` inclusive for display, `toExclusiveDate` as the half-open upper
// bound (1 Jan of the following year) — same convention as the other reports.
//
// Deliberately returns *dates*, not instants. Which moment a calendar date
// begins at depends on the company's timezone (TMC-157), and that resolution
// belongs in SQL where real tzdata lives — this module stays pure so the form
// mapping can be unit-tested without a database.
//
// Deliberately calendar-year: every other report defaults to year-to-date, but
// a tax form is always Jan 1 – Dec 31 of a filed year. Fiscal-year filers are a
// v1.x concern and would need a company-level year-end first.
export function taxYearWindow(year: number): {
  from: string;
  to: string;
  toExclusiveDate: string;
} {
  return {
    from: `${year}-01-01`,
    to: `${year}-12-31`,
    toExclusiveDate: `${year + 1}-01-01`,
  };
}
