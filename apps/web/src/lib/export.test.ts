import { describe, expect, it } from 'vitest';
import { entityRowsToCsv, formatCell } from './export';
import { entityByKey } from './import/descriptors';

const contacts = entityByKey('contacts');
const items = entityByKey('items');

function field(entity: ReturnType<typeof entityByKey>, key: string) {
  const f = entity.fields.find((x) => x.key === key);
  if (!f) throw new Error(`no field ${key}`);
  return f;
}

describe('formatCell', () => {
  it('renders taxable as yes/no, never a raw boolean', () => {
    expect(formatCell(field(items, 'taxable'), true)).toBe('yes');
    expect(formatCell(field(items, 'taxable'), false)).toBe('no');
  });

  it('maps null/undefined to an empty cell, not "null"', () => {
    expect(formatCell(field(contacts, 'email'), null)).toBe('');
    expect(formatCell(field(contacts, 'phone'), undefined)).toBe('');
    expect(formatCell(field(items, 'taxable'), null)).toBe('');
  });

  it('passes decimal-string money/quantity through unchanged', () => {
    expect(formatCell(field(items, 'unitPrice'), '65.00')).toBe('65.00');
    expect(formatCell(field(items, 'defaultQuantity'), '1.0000')).toBe('1.0000');
  });

  it('passes the item type through as-is', () => {
    expect(formatCell(field(items, 'type'), 'product')).toBe('product');
    expect(formatCell(field(items, 'type'), 'service')).toBe('service');
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
      },
    ]);
    const [, row] = csv.trimEnd().split('\n');
    expect(row).toBe('Lawn Mowing,Front + back,service,45.00,hour,1.0000,no');
  });

  it('RFC-4180 quotes cells containing a comma', () => {
    const csv = entityRowsToCsv(contacts, [{ name: 'Acme, Inc.' }]);
    expect(csv.trimEnd().split('\n')[1]).toBe('"Acme, Inc.",,,,,,,,,');
  });
});
