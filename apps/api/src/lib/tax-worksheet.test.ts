import { chartForBusinessType } from '@thalermark/db';
import { describe, expect, it } from 'vitest';
import {
  type ExpenseAccountAmount,
  TAX_FORMS,
  type TaxFormCode,
  parseTaxMapping,
  rollUpDeductions,
  taxFormFor,
  taxYearWindow,
} from './tax-worksheet.js';

// Pure-policy coverage for the four form mappings. The SQL that feeds them — and
// the cash/accrual basis split — is covered in
// apps/api/tests/tax-worksheet.integration.test.ts.

const acct = (
  code: string,
  name: string,
  taxMapping: string | null,
  amount: string,
): ExpenseAccountAmount => ({ code, name, taxMapping, amount });

const SCHEDULE_C = TAX_FORMS.schedule_c;
const FORM_1065 = TAX_FORMS['1065'];
const FORM_1120S = TAX_FORMS['1120s'];
const FORM_1120 = TAX_FORMS['1120'];

describe('parseTaxMapping', () => {
  it('reads the seeded mapping format for every form', () => {
    expect(parseTaxMapping('Schedule C, Line 8')).toEqual({ form: 'schedule_c', line: '8' });
    expect(parseTaxMapping('Form 1065, Line 20')).toEqual({ form: '1065', line: '20' });
    expect(parseTaxMapping('Form 1120-S, Line 19')).toEqual({ form: '1120s', line: '19' });
    expect(parseTaxMapping('Form 1120, Line 26')).toEqual({ form: '1120', line: '26' });
  });

  // The whole point of the exact-prefix map. A regex alternation with `1120`
  // ahead of `1120-S` matches BOTH against an S-corp mapping and rolls its
  // accounts onto C-corp line numbers — every line differs between the two
  // forms, so the failure would be silent and total.
  it('never confuses Form 1120-S with Form 1120', () => {
    expect(parseTaxMapping('Form 1120-S, Line 7')?.form).toBe('1120s');
    expect(parseTaxMapping('Form 1120, Line 7')?.form).toBe('1120');
    expect(parseTaxMapping('form 1120-s, line 12')?.form).toBe('1120s');
  });

  it('tolerates casing and spacing drift from a hand-edited account', () => {
    expect(parseTaxMapping('schedule c line 22')).toEqual({ form: 'schedule_c', line: '22' });
    expect(parseTaxMapping('SCHEDULE C,   LINE 24B')).toEqual({ form: 'schedule_c', line: '24b' });
    expect(parseTaxMapping('  Form 1065 ,  Line 16a  ')).toEqual({ form: '1065', line: '16a' });
  });

  it('accepts the long-form Schedule C name the overlay carries', () => {
    expect(parseTaxMapping('Schedule C (Form 1040), Line 8')?.form).toBe('schedule_c');
  });

  it('returns null for anything it cannot place', () => {
    expect(parseTaxMapping(null)).toBeNull();
    expect(parseTaxMapping('')).toBeNull();
    expect(parseTaxMapping('Form 990, Line 1')).toBeNull();
    expect(parseTaxMapping('Schedule C')).toBeNull();
    expect(parseTaxMapping('not a mapping at all')).toBeNull();
  });
});

// The test the ticket asks for: every mapping string the seeds actually write,
// fed through the parser, must resolve to the form that entity files and to a
// line that exists on it. Catches a seed typo, a form-name drift, and the
// 1120/1120-S collision in one pass — and it reads the real seeds, so a future
// account added to an overlay is covered without touching this file.
describe('seeded tax mappings all resolve', () => {
  const CASES: { businessType: string; form: TaxFormCode }[] = [
    { businessType: 'sole_prop', form: 'schedule_c' },
    { businessType: 'llc_single_member', form: 'schedule_c' },
    { businessType: 'partnership', form: '1065' },
    { businessType: 's_corp', form: '1120s' },
    { businessType: 'c_corp', form: '1120' },
  ];

  for (const { businessType, form } of CASES) {
    it(`${businessType} maps only onto ${form}`, () => {
      const seeds = chartForBusinessType(businessType).filter((s) => s.taxMapping !== null);
      // Guard against the chart silently losing its mappings — an empty list
      // would make every assertion below vacuously pass.
      expect(seeds.length).toBeGreaterThan(15);

      const def = TAX_FORMS[form];
      const known = new Set([
        ...def.income.map((l) => l.line),
        ...def.deductions.map((l) => l.line),
      ]);

      for (const seed of seeds) {
        const parsed = parseTaxMapping(seed.taxMapping);
        expect(parsed, `${seed.code} ${seed.name}: ${seed.taxMapping}`).not.toBeNull();
        expect(parsed?.form, `${seed.code} ${seed.name}: ${seed.taxMapping}`).toBe(form);
        expect(known.has(parsed?.line ?? ''), `${seed.code} → line ${parsed?.line}`).toBe(true);
      }
    });

    it(`${businessType} routes every expense account to a deduction line`, () => {
      const seeds = chartForBusinessType(businessType).filter(
        (s) => s.accountType === 'expense' && s.taxMapping !== null,
      );
      const byLine = new Map(TAX_FORMS[form].deductions.map((l) => [l.line, l]));
      for (const seed of seeds) {
        const line = byLine.get(parseTaxMapping(seed.taxMapping)?.line ?? '');
        // 'mapped' is the only role that can receive an account — a mapping
        // pointing at a computed or user-supplied line would silently fall into
        // the unmapped bucket at runtime.
        expect(line?.role, `${seed.code} ${seed.name}: ${seed.taxMapping}`).toBe('mapped');
      }
    });
  }
});

describe('taxFormFor', () => {
  it('maps each business type to the return it files', () => {
    expect(taxFormFor('sole_prop').code).toBe('schedule_c');
    expect(taxFormFor('llc_single_member').code).toBe('schedule_c');
    expect(taxFormFor('partnership').code).toBe('1065');
    expect(taxFormFor('s_corp').code).toBe('1120s');
    expect(taxFormFor('c_corp').code).toBe('1120');
  });

  // The provisional chart seeded before onboarding asks is the sole-prop one, so
  // the worksheet has to match the accounts that actually exist.
  it('treats an unresolved business type as Schedule C', () => {
    expect(taxFormFor(null).code).toBe('schedule_c');
    expect(taxFormFor(undefined).code).toBe('schedule_c');
    expect(taxFormFor('').code).toBe('schedule_c');
  });
});

describe('rollUpDeductions', () => {
  it('emits every deduction line in form order, zero-filled', () => {
    const { rows } = rollUpDeductions([], SCHEDULE_C);
    expect(rows).toHaveLength(SCHEDULE_C.deductions.length);
    expect(rows.map((r) => r.line).slice(0, 6)).toEqual(['8', '9', '10', '11', '12', '13']);
    expect(rows.every((r) => r.amount === '0.00' || r.amount === null)).toBe(true);
  });

  it('rolls multiple accounts onto one line and keeps the breakdown', () => {
    const { rows } = rollUpDeductions(
      [
        acct('7900', 'Other Expenses', 'Schedule C, Line 27b', '40.00'),
        acct('7950', 'Merchant Processing Fees', 'Schedule C, Line 27b', '3.44'),
      ],
      SCHEDULE_C,
    );
    const row = rows.find((r) => r.line === '27b');
    expect(row?.amount).toBe('43.44');
    expect(row?.accounts).toEqual([
      { code: '7900', name: 'Other Expenses', amount: '40.00' },
      { code: '7950', name: 'Merchant Processing Fees', amount: '3.44' },
    ]);
  });

  it('renders a line nothing can fill as blank, not zero', () => {
    const { rows } = rollUpDeductions([], SCHEDULE_C);
    // 30, business use of home — no data model at all.
    expect(rows.find((r) => r.line === '30')?.amount).toBeNull();
    expect(rows.find((r) => r.line === '30')?.userSupplied).toBe(true);
    expect(rows.find((r) => r.line === '8')?.amount).toBe('0.00');
  });

  // Line 9 is both: 6100 posts direct vehicle costs, and the user still owes the
  // mileage we don't track. Flagging it must not stop the books' half landing.
  it('fills a part-known user-supplied line from the books', () => {
    const { rows } = rollUpDeductions(
      [acct('6100', 'Car & Truck Expenses', 'Schedule C, Line 9', '412.80')],
      SCHEDULE_C,
    );
    const row = rows.find((r) => r.line === '9');
    expect(row?.amount).toBe('412.80');
    expect(row?.userSupplied).toBe(true);
    expect(row?.accounts).toEqual([
      { code: '6100', name: 'Car & Truck Expenses', amount: '412.80' },
    ]);
  });

  // Dropping an account we can't place would make the total disagree with the
  // P&L, which is a worse failure than surfacing something unplaceable.
  it('surfaces unmapped accounts but still counts them in the total', () => {
    const { rows, unmapped, totalDeductions } = rollUpDeductions(
      [
        acct('6000', 'Advertising', 'Schedule C, Line 8', '100.00'),
        acct('8100', 'Custom Thing', null, '25.00'),
      ],
      SCHEDULE_C,
    );
    expect(rows.find((r) => r.line === '8')?.amount).toBe('100.00');
    expect(unmapped).toEqual([{ code: '8100', name: 'Custom Thing', amount: '25.00' }]);
    expect(totalDeductions).toBe('125.00');
  });

  it('ignores zero-value accounts in the breakdown and the unmapped list', () => {
    const { rows, unmapped } = rollUpDeductions(
      [
        acct('6000', 'Advertising', 'Schedule C, Line 8', '0.00'),
        acct('8100', 'Untouched Custom', null, '0.00'),
      ],
      SCHEDULE_C,
    );
    expect(rows.find((r) => r.line === '8')?.accounts).toEqual([]);
    expect(unmapped).toEqual([]);
  });

  // A refund or in-period correction can drive a category negative; the form
  // has to carry it through rather than clamping at zero.
  it('carries negative account balances through', () => {
    const { rows, totalDeductions } = rollUpDeductions(
      [
        acct('7000', 'Supplies', 'Schedule C, Line 22', '100.00'),
        acct('7900', 'Other Expenses', 'Schedule C, Line 27b', '-30.00'),
      ],
      SCHEDULE_C,
    );
    expect(rows.find((r) => r.line === '27b')?.amount).toBe('-30.00');
    expect(totalDeductions).toBe('70.00');
  });

  // The failure this whole design guards against: a stale mapping landing on a
  // plausible wrong line instead of being flagged for review.
  it('refuses a mapping that names a different form', () => {
    const { rows, unmapped } = rollUpDeductions(
      [acct('7450', 'Officer Compensation', 'Form 1120-S, Line 7', '5000.00')],
      FORM_1120,
    );
    // Line 7 on the 1120 is gross royalties, an income line — nothing lands.
    expect(rows.find((r) => r.line === '12')?.amount).toBe('0.00');
    expect(unmapped).toEqual([{ code: '7450', name: 'Officer Compensation', amount: '5000.00' }]);
  });

  // Pinned against the TY2025 forms (TMC-167). These four numbers are the ones
  // that moved when the §179D energy deduction was inserted, and they carry
  // most of a chart on three of the four forms — so if a future form shifts
  // them again and nobody notices, most of a business's spend lands on the
  // wrong line of a real tax return.
  it('puts the itemised catch-all on the line the IRS prints it on', () => {
    expect(SCHEDULE_C.deductions.find((l) => l.itemized)?.line).toBe('27b');
    expect(FORM_1065.deductions.find((l) => l.itemized)?.line).toBe('21');
    expect(FORM_1120S.deductions.find((l) => l.itemized)?.line).toBe('20');
    expect(FORM_1120.deductions.find((l) => l.itemized)?.line).toBe('26');
  });

  // The direct regression guard: the energy line must exist, sit immediately
  // before the catch-all, and never BE the catch-all. Getting this wrong is
  // precisely the bug TMC-167 fixed — and it is invisible to every other
  // assertion in this file, because a table that points at the wrong line is
  // still perfectly self-consistent.
  it('keeps the energy deduction line distinct from other deductions', () => {
    const cases = [
      { form: SCHEDULE_C, energy: '27a', other: '27b' },
      { form: FORM_1065, energy: '20', other: '21' },
      { form: FORM_1120S, energy: '19', other: '20' },
      { form: FORM_1120, energy: '25', other: '26' },
    ];
    for (const { form, energy, other } of cases) {
      const lines = form.deductions.map((l) => l.line);
      expect(lines.indexOf(energy), form.name).toBe(lines.indexOf(other) - 1);
      expect(form.deductions.find((l) => l.line === energy)?.label, form.name).toMatch(
        /energy efficient commercial (buildings|bldgs) deduction/i,
      );
      expect(form.deductions.find((l) => l.line === energy)?.itemized, form.name).toBeUndefined();
      expect(form.deductions.find((l) => l.line === other)?.label, form.name).toMatch(
        /other (expenses|deductions)/i,
      );
    }
  });

  // The statement attached to that line is the real output of the three
  // corporate/partnership worksheets — 13 of the 1065's 23 mapped accounts land
  // on line 20 alone.
  it('keeps the full account breakdown behind the catch-all line', () => {
    const { rows } = rollUpDeductions(
      [
        acct('6700', 'Office Expense', 'Form 1065, Line 21', '240.00'),
        acct('7000', 'Supplies', 'Form 1065, Line 21', '1105.60'),
        acct('7400', 'Utilities', 'Form 1065, Line 21', '88.12'),
      ],
      FORM_1065,
    );
    const row = rows.find((r) => r.line === '21');
    expect(row?.amount).toBe('1433.72');
    expect(row?.accounts.map((a) => a.code)).toEqual(['6700', '7000', '7400']);
  });

  // 1065 line 21 sums the right-hand column, where 16c — not 16a — is the entry.
  it('nets the 1065 depreciation sub-lines into 16c', () => {
    const { rows, totalDeductions } = rollUpDeductions(
      [acct('6350', 'Depreciation', 'Form 1065, Line 16a', '900.00')],
      FORM_1065,
    );
    expect(rows.find((r) => r.line === '16a')?.amount).toBe('900.00');
    expect(rows.find((r) => r.line === '16b')?.amount).toBe('0.00');
    expect(rows.find((r) => r.line === '16c')?.amount).toBe('900.00');
    // Counted once, via the account — not once per line it appears on.
    expect(totalDeductions).toBe('900.00');
  });

  // The C-corp correctness bug this ticket had to fix: income tax is not a
  // deductible expense on the corporation's own return. 7800 is a real expense
  // account, so without excludeFromTotal it flows into total deductions and
  // understates taxable income by exactly the tax.
  it('keeps Form 1120 line 31 off the deductions total', () => {
    const { rows, totalDeductions, excludedTotals } = rollUpDeductions(
      [
        acct('7000', 'Supplies', 'Form 1120, Line 26', '1000.00'),
        acct('7800', 'Income Tax Expense', 'Form 1120, Line 31', '4200.00'),
      ],
      FORM_1120,
    );
    expect(rows.find((r) => r.line === '31')?.amount).toBe('4200.00');
    expect(excludedTotals).toEqual({ '31': '4200.00' });
    expect(totalDeductions).toBe('1000.00');
  });
});

describe('taxYearWindow', () => {
  // Calendar dates, not instants: which moment 1 January begins at depends on
  // the company's timezone, and that resolution happens in SQL (TMC-157).
  it('spans the full calendar year with a half-open upper bound', () => {
    expect(taxYearWindow(2026)).toEqual({
      from: '2026-01-01',
      to: '2026-12-31',
      toExclusiveDate: '2027-01-01',
    });
  });

  it('ends on 31 December in a leap year too', () => {
    const w = taxYearWindow(2028);
    expect(w.to).toBe('2028-12-31');
    expect(w.toExclusiveDate).toBe('2029-01-01');
  });
});
