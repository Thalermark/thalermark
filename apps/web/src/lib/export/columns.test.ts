import { describe, expect, it } from 'vitest';
import { EXPORT_COLUMNS, rowsToCsv } from './columns';

const cols = [
  { key: 'a', label: 'Alpha' },
  { key: 'b', label: 'Beta' },
];

describe('rowsToCsv', () => {
  it('writes a header row of labels then one row per record', () => {
    const csv = rowsToCsv(cols, [
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
    expect(csv).toBe('Alpha,Beta\n1,2\n3,4\n');
  });

  it('emits a header-only file for an empty list', () => {
    expect(rowsToCsv(cols, [])).toBe('Alpha,Beta\n');
  });

  it('formats cells: money passes through, boolean → yes/no, null/missing → empty', () => {
    const csv = rowsToCsv(cols, [{ a: '65.00', b: true }, { a: null }]);
    expect(csv).toBe('Alpha,Beta\n65.00,yes\n,\n');
  });

  it('quotes a cell containing a comma (RFC 4180)', () => {
    expect(rowsToCsv([{ key: 'x', label: 'X' }], [{ x: 'a,b' }])).toBe('X\n"a,b"\n');
  });
});

describe('EXPORT_COLUMNS', () => {
  it('resolves the customer name column on invoices and estimates', () => {
    expect(EXPORT_COLUMNS.invoices.columns.find((c) => c.key === 'contactName')?.label).toBe(
      'Customer',
    );
    expect(EXPORT_COLUMNS.estimates.columns.find((c) => c.key === 'contactName')?.label).toBe(
      'Customer',
    );
  });

  it('gives every entity a .csv file name', () => {
    for (const spec of Object.values(EXPORT_COLUMNS)) {
      expect(spec.file).toMatch(/\.csv$/);
    }
  });
});
