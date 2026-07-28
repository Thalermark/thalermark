import { describe, expect, it } from 'vitest';
import {
  type ImportAccount,
  importBalance,
  matchAccount,
  parseMoneyCents,
  parseTrialBalance,
} from './trial-balance-import';

// Fixtures modelled on what QuickBooks, Xero and Wave actually export: a title
// row above the header, "$" and thousands separators, parenthesised negatives,
// and a Total row that must not be imported as an account.

const ACCOUNTS: ImportAccount[] = [
  { id: 'a-1000', code: '1000', name: 'Cash', accountType: 'asset' },
  { id: 'a-4000', code: '4000', name: 'Service Revenue', accountType: 'revenue' },
  { id: 'a-6000', code: '6000', name: 'Advertising', accountType: 'expense' },
  { id: 'a-7000', code: '7000', name: 'Supplies', accountType: 'expense' },
];

describe('parseMoneyCents', () => {
  it('reads the shapes accounting exports use', () => {
    expect(parseMoneyCents('1234.56')).toBe(123456);
    expect(parseMoneyCents('$1,234.56')).toBe(123456);
    expect(parseMoneyCents(' 89.00 ')).toBe(8900);
  });

  it('treats parentheses and a leading minus as negative', () => {
    expect(parseMoneyCents('(89.00)')).toBe(-8900);
    expect(parseMoneyCents('-89.00')).toBe(-8900);
    expect(parseMoneyCents('($1,000.00)')).toBe(-100000);
  });

  it('reads blank and dash placeholders as nil', () => {
    expect(parseMoneyCents('')).toBe(0);
    expect(parseMoneyCents('   ')).toBe(0);
    expect(parseMoneyCents('-')).toBe(0);
    expect(parseMoneyCents('—')).toBe(0);
  });

  // Rounding in cents, never floats — the same discipline the API applies.
  it('rounds to cents rather than carrying float error', () => {
    expect(parseMoneyCents('0.1')).toBe(10);
    expect(parseMoneyCents('1234.565')).toBe(123457);
  });
});

describe('matchAccount', () => {
  it('matches on a leading account code', () => {
    expect(matchAccount('7000 Supplies', ACCOUNTS)?.id).toBe('a-7000');
    expect(matchAccount('7000', ACCOUNTS)?.id).toBe('a-7000');
    expect(matchAccount('7000 - Supplies', ACCOUNTS)?.id).toBe('a-7000');
  });

  it('matches on an exact name, ignoring case and spacing', () => {
    expect(matchAccount('supplies', ACCOUNTS)?.id).toBe('a-7000');
    expect(matchAccount('  Service   Revenue ', ACCOUNTS)?.id).toBe('a-4000');
  });

  // Their code, our name — common when the chart was renumbered.
  it('falls back to the name when the code is not ours', () => {
    expect(matchAccount('5150 Advertising', ACCOUNTS)?.id).toBe('a-6000');
  });

  // Deliberately no fuzzy matching: a wrong account silently absorbs money,
  // and "close enough" is not a standard to apply to tax figures.
  it('refuses anything it cannot place exactly', () => {
    expect(matchAccount('Advertising & Promotion', ACCOUNTS)).toBeNull();
    expect(matchAccount('Subcontractors', ACCOUNTS)).toBeNull();
    expect(matchAccount('', ACCOUNTS)).toBeNull();
  });
});

describe('parseTrialBalance', () => {
  const QUICKBOOKS = [
    ['Ray Lawn Care'],
    ['Trial Balance'],
    ['As of July 27, 2026'],
    [],
    ['Account', 'Debit', 'Credit'],
    ['1000 Cash', '5,000.00', ''],
    ['7000 Supplies', '3,000.00', ''],
    ['4000 Service Revenue', '', '8,000.00'],
    ['Total', '8,000.00', '8,000.00'],
  ];

  it('finds the header below a title block and reads the rows', () => {
    const { lines, unmatched, error } = parseTrialBalance(QUICKBOOKS, ACCOUNTS);
    expect(error).toBeUndefined();
    expect(unmatched).toEqual([]);
    expect(lines).toEqual([
      { coaAccountId: 'a-1000', side: 'debit', amount: '5000.00', sourceLabel: '1000 Cash' },
      { coaAccountId: 'a-7000', side: 'debit', amount: '3000.00', sourceLabel: '7000 Supplies' },
      {
        coaAccountId: 'a-4000',
        side: 'credit',
        amount: '8000.00',
        sourceLabel: '4000 Service Revenue',
      },
    ]);
  });

  // Importing the Total row would double the entire import and still balance,
  // so nothing downstream would notice.
  it('skips total and subtotal rows', () => {
    const { lines } = parseTrialBalance(QUICKBOOKS, ACCOUNTS);
    expect(lines).toHaveLength(3);
    expect(importBalance(lines).debitCents).toBe(800000);
  });

  it('handles a single signed amount column', () => {
    const rows = [
      ['Account', 'Balance'],
      ['1000 Cash', '5000.00'],
      ['4000 Service Revenue', '(8000.00)'],
      ['7000 Supplies', '3000.00'],
    ];
    const { lines } = parseTrialBalance(rows, ACCOUNTS);
    expect(lines.map((l) => `${l.side}:${l.amount}`)).toEqual([
      'debit:5000.00',
      'credit:8000.00',
      'debit:3000.00',
    ]);
  });

  it('surfaces rows it cannot place instead of dropping them', () => {
    const rows = [
      ['Account', 'Debit', 'Credit'],
      ['7000 Supplies', '100.00', ''],
      ['Subcontractor costs', '250.00', ''],
    ];
    const { lines, unmatched } = parseTrialBalance(rows, ACCOUNTS);
    expect(lines).toHaveLength(1);
    expect(unmatched).toEqual([{ label: 'Subcontractor costs', side: 'debit', amount: '250.00' }]);
  });

  it('skips zero and blank rows', () => {
    const rows = [
      ['Account', 'Debit', 'Credit'],
      ['1000 Cash', '0.00', ''],
      ['', '', ''],
      ['7000 Supplies', '', '-'],
      ['6000 Advertising', '50.00', ''],
    ];
    const { lines } = parseTrialBalance(rows, ACCOUNTS);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.coaAccountId).toBe('a-6000');
  });

  it('nets a row that carries both a debit and a credit', () => {
    const rows = [
      ['Account', 'Debit', 'Credit'],
      ['7000 Supplies', '500.00', '200.00'],
    ];
    const { lines } = parseTrialBalance(rows, ACCOUNTS);
    expect(lines[0]).toMatchObject({ side: 'debit', amount: '300.00' });
  });

  it('reports a file it cannot read at all', () => {
    expect(
      parseTrialBalance(
        [
          ['a', 'b'],
          ['1', '2'],
        ],
        ACCOUNTS,
      ).error,
    ).toBe('no_columns');
    expect(parseTrialBalance([['Account', 'Debit', 'Credit']], ACCOUNTS).error).toBe('no_rows');
  });
});

describe('importBalance', () => {
  it('reports whether the file balanced as imported', () => {
    const balanced = importBalance([
      { coaAccountId: 'x', side: 'debit', amount: '100.00', sourceLabel: '' },
      { coaAccountId: 'y', side: 'credit', amount: '100.00', sourceLabel: '' },
    ]);
    expect(balanced).toEqual({ debitCents: 10000, creditCents: 10000, balanced: true });

    // An unmatched row left out of `lines` is the usual reason a real import
    // doesn't balance — the review step has to be able to say so.
    const off = importBalance([
      { coaAccountId: 'x', side: 'debit', amount: '100.00', sourceLabel: '' },
      { coaAccountId: 'y', side: 'credit', amount: '75.00', sourceLabel: '' },
    ]);
    expect(off.balanced).toBe(false);
    expect(off.debitCents - off.creditCents).toBe(2500);
  });
});
