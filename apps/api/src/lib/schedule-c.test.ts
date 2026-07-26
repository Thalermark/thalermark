import { describe, expect, it } from 'vitest';
import {
  type ExpenseAccountAmount,
  SCHEDULE_C_PART_II,
  parseScheduleCLine,
  rollUpPartII,
  taxYearWindow,
} from './schedule-c.js';

// Pure-policy coverage for the Schedule C form mapping. The SQL that feeds it —
// and the cash/accrual basis split — is covered in
// apps/api/tests/schedule-c.integration.test.ts.

const acct = (
  code: string,
  name: string,
  taxMapping: string | null,
  amount: string,
): ExpenseAccountAmount => ({ code, name, taxMapping, amount });

describe('parseScheduleCLine', () => {
  it('reads the seeded mapping format', () => {
    expect(parseScheduleCLine('Schedule C, Line 8')).toBe('8');
    expect(parseScheduleCLine('Schedule C, Line 27a')).toBe('27a');
    expect(parseScheduleCLine('Schedule C, Line 16b')).toBe('16b');
  });

  it('tolerates casing and spacing drift from a hand-edited account', () => {
    expect(parseScheduleCLine('schedule c line 22')).toBe('22');
    expect(parseScheduleCLine('SCHEDULE C,   LINE 24B')).toBe('24b');
  });

  it('returns null for anything it cannot place', () => {
    expect(parseScheduleCLine(null)).toBeNull();
    expect(parseScheduleCLine('')).toBeNull();
    // A future 1120-S seed — real mapping, wrong form.
    expect(parseScheduleCLine('Form 1120-S, Line 7')).toBeNull();
    // Well-formed but not a line we render (Part I / Part III live elsewhere).
    expect(parseScheduleCLine('Schedule C, Line 1')).toBeNull();
    expect(parseScheduleCLine('Schedule C, Line 42')).toBeNull();
  });
});

describe('rollUpPartII', () => {
  it('emits every Part II line in form order, zero-filled', () => {
    const { rows } = rollUpPartII([]);
    expect(rows).toHaveLength(SCHEDULE_C_PART_II.length);
    expect(rows.map((r) => r.line).slice(0, 6)).toEqual(['8', '9', '10', '11', '12', '13']);
    expect(rows.every((r) => r.amount === '0.00')).toBe(true);
  });

  // 27a carries both Other Expenses (7900) and Merchant Processing Fees (7950)
  // in the shipped seed, so the group-by is real, not a relabel.
  it('rolls multiple accounts onto one line and keeps the breakdown', () => {
    const { rows } = rollUpPartII([
      acct('7900', 'Other Expenses', 'Schedule C, Line 27a', '40.00'),
      acct('7950', 'Merchant Processing Fees', 'Schedule C, Line 27a', '3.44'),
    ]);
    const row = rows.find((r) => r.line === '27a');
    expect(row?.amount).toBe('43.44');
    expect(row?.accounts).toEqual([
      { code: '7900', name: 'Other Expenses', amount: '40.00' },
      { code: '7950', name: 'Merchant Processing Fees', amount: '3.44' },
    ]);
  });

  it('marks the lines we structurally cannot fill', () => {
    const { rows } = rollUpPartII([]);
    expect(rows.find((r) => r.line === '9')?.userSupplied).toBe(true);
    expect(rows.find((r) => r.line === '8')?.userSupplied).toBeUndefined();
  });

  // Dropping an account we can't place would make line 28 disagree with the
  // P&L, which is a worse failure than surfacing something unplaceable.
  it('surfaces unmapped accounts but still counts them in the total', () => {
    const { rows, unmapped, totalExpenses } = rollUpPartII([
      acct('6000', 'Advertising', 'Schedule C, Line 8', '100.00'),
      acct('8100', 'Custom Thing', null, '25.00'),
    ]);
    expect(rows.find((r) => r.line === '8')?.amount).toBe('100.00');
    expect(unmapped).toEqual([{ code: '8100', name: 'Custom Thing', amount: '25.00' }]);
    expect(totalExpenses).toBe('125.00');
  });

  it('ignores zero-value accounts in the breakdown and the unmapped list', () => {
    const { rows, unmapped } = rollUpPartII([
      acct('6000', 'Advertising', 'Schedule C, Line 8', '0.00'),
      acct('8100', 'Untouched Custom', null, '0.00'),
    ]);
    expect(rows.find((r) => r.line === '8')?.accounts).toEqual([]);
    expect(unmapped).toEqual([]);
  });

  // A refund or in-period correction can drive a category negative; the form
  // has to carry it through rather than clamping at zero.
  it('carries negative account balances through', () => {
    const { rows, totalExpenses } = rollUpPartII([
      acct('7000', 'Supplies', 'Schedule C, Line 22', '100.00'),
      acct('7900', 'Other Expenses', 'Schedule C, Line 27a', '-30.00'),
    ]);
    expect(rows.find((r) => r.line === '27a')?.amount).toBe('-30.00');
    expect(totalExpenses).toBe('70.00');
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
