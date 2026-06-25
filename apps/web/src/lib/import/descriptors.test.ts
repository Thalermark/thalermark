import { describe, expect, it } from 'vitest';
import { autoMap, entityByKey } from './descriptors';

const contacts = entityByKey('contacts');
const items = entityByKey('items');

function coerce(entity: ReturnType<typeof entityByKey>, key: string, raw: string) {
  const field = entity.fields.find((f) => f.key === key);
  if (!field) throw new Error(`no field ${key}`);
  return field.coerce(raw);
}

describe('autoMap', () => {
  it('matches headers to fields by synonym, normalizing case/spacing/punctuation', () => {
    const map = autoMap(contacts, ['Full Name', 'E-mail Address', 'Phone #', 'Zip Code']);
    expect(map.name).toBe('Full Name');
    expect(map.email).toBe('E-mail Address');
    expect(map.phone).toBe('Phone #');
    expect(map.postalCode).toBe('Zip Code');
  });

  it('does not assign one header to two fields', () => {
    // "notes" is a synonym for both item description and... only description here;
    // ensure a single header is claimed once.
    const map = autoMap(items, ['Name', 'Notes']);
    expect(map.name).toBe('Name');
    expect(map.description).toBe('Notes');
    const claimed = Object.values(map);
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it('leaves unmatched fields out of the map', () => {
    const map = autoMap(contacts, ['Name']);
    expect(map.name).toBe('Name');
    expect(map.country).toBeUndefined();
  });
});

describe('coercion', () => {
  it('strips currency punctuation from money', () => {
    expect(coerce(items, 'unitPrice', '$1,250.00')).toBe('1250.00');
    expect(coerce(items, 'unitPrice', '  45.5 ')).toBe('45.5');
    expect(coerce(items, 'unitPrice', '')).toBeUndefined();
  });

  it('normalizes item type', () => {
    expect(coerce(items, 'type', 'Product')).toBe('product');
    expect(coerce(items, 'type', 'SERVICE')).toBe('service');
    expect(coerce(items, 'type', 'Labor')).toBe('service');
    expect(coerce(items, 'type', 'svc')).toBe('svc'); // unrecognized → row error downstream
    expect(coerce(items, 'type', '')).toBeUndefined();
  });

  it('coerces taxable booleans', () => {
    expect(coerce(items, 'taxable', 'yes')).toBe(true);
    expect(coerce(items, 'taxable', 'TRUE')).toBe(true);
    expect(coerce(items, 'taxable', 'no')).toBe(false);
    expect(coerce(items, 'taxable', '')).toBeUndefined();
  });

  it('uppercases country', () => {
    expect(coerce(contacts, 'country', 'us')).toBe('US');
  });
});

describe('validateRow', () => {
  it('accepts a row with the required name and coerced fields', () => {
    const res = items.validateRow({ name: 'Lawn Mowing', type: 'service', unitPrice: '45.00' });
    expect(res.ok).toBe(true);
  });

  it('rejects a row missing the required name', () => {
    const res = contacts.validateRow({ email: 'a@b.example' });
    expect(res.ok).toBe(false);
  });

  it('rejects a row whose money survived coercion still malformed', () => {
    const res = items.validateRow({ name: 'Bad', unitPrice: '10.999' });
    expect(res.ok).toBe(false);
  });
});
