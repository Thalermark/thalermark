import { describe, expect, it } from 'vitest';
import { entityRowsToCsv, formatCell } from './export';
import { entityByKey } from './import/descriptors';

const contacts = entityByKey('contacts');
const items = entityByKey('items');

describe('formatCell', () => {
  it('renders booleans (taxable, archived) as yes/no, never a raw boolean', () => {
    expect(formatCell(true)).toBe('yes');
    expect(formatCell(false)).toBe('no');
  });

  it('maps null/undefined to an empty cell, not "null"', () => {
    expect(formatCell(null)).toBe('');
    expect(formatCell(undefined)).toBe('');
  });

  it('passes decimal-string money/quantity through unchanged', () => {
    expect(formatCell('65.00')).toBe('65.00');
    expect(formatCell('1.0000')).toBe('1.0000');
  });

  it('passes string values (e.g. item type) through as-is', () => {
    expect(formatCell('product')).toBe('product');
    expect(formatCell('service')).toBe('service');
  });
});

describe('entityRowsToCsv', () => {
  it('writes a label header row even for an empty list', () => {
    const csv = entityRowsToCsv(contacts, []);
    expect(csv).toBe(`${contacts.fields.map((f) => f.label).join(',')}\n`);
  });

  it('serializes a row in field order with round-trip-safe cells', () => {
    const csv = entityRowsToCsv(items, [
      {
        name: 'Lawn Mowing',
        description: 'Front + back',
        type: 'service',
        unitPrice: '45.00',
        unitLabel: 'hour',
        defaultQuantity: '1.0000',
        taxable: false,
        archived: true,
      },
    ]);
    const [, row] = csv.trimEnd().split('\n');
    expect(row).toBe('Lawn Mowing,Front + back,service,45.00,hour,1.0000,no,yes');
  });

  it('RFC-4180 quotes cells containing a comma', () => {
    const csv = entityRowsToCsv(contacts, [{ name: 'Acme, Inc.' }]);
    expect(csv.trimEnd().split('\n')[1]).toBe('"Acme, Inc.",,,,,,,,,');
  });
});
