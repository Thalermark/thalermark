import { describe, expect, it } from 'vitest';
import { contactCreateSchema } from './contact.js';
import {
  invoiceCreateSchema,
  invoiceLineItemInputSchema,
  invoiceMarkPaidSchema,
} from './invoice.js';
import { isoDateString, moneyString, quantityString } from './money.js';

describe('moneyString', () => {
  it.each(['0', '0.00', '1', '1.5', '1.50', '1234567890.99'])('accepts %s', (input) => {
    expect(moneyString.parse(input)).toBe(input);
  });

  it.each(['', '-1.00', '1.234', '.5', 'abc', '1,000.00'])('rejects %s', (input) => {
    expect(moneyString.safeParse(input).success).toBe(false);
  });
});

describe('quantityString', () => {
  it('accepts up to 4 fractional digits', () => {
    expect(quantityString.parse('2.5000')).toBe('2.5000');
  });

  it('rejects 5 fractional digits', () => {
    expect(quantityString.safeParse('2.50001').success).toBe(false);
  });
});

describe('isoDateString', () => {
  it('accepts YYYY-MM-DD', () => {
    expect(isoDateString.parse('2026-05-23')).toBe('2026-05-23');
  });

  it.each(['2026-5-23', '05/23/2026', '2026-05-23T00:00:00Z'])('rejects %s', (input) => {
    expect(isoDateString.safeParse(input).success).toBe(false);
  });
});

describe('contactCreateSchema', () => {
  it('accepts a minimal contact', () => {
    const parsed = contactCreateSchema.parse({
      companyId: '01890000-0000-7000-8000-000000000001',
      name: 'Wile E. Coyote',
    });
    expect(parsed.name).toBe('Wile E. Coyote');
    expect(parsed.email).toBeUndefined();
  });

  it('rejects an empty name', () => {
    const r = contactCreateSchema.safeParse({
      companyId: '01890000-0000-7000-8000-000000000001',
      name: '',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a malformed email', () => {
    const r = contactCreateSchema.safeParse({
      companyId: '01890000-0000-7000-8000-000000000001',
      name: 'X',
      email: 'not-an-email',
    });
    expect(r.success).toBe(false);
  });
});

describe('invoiceLineItemInputSchema', () => {
  it('accepts a typical line', () => {
    const parsed = invoiceLineItemInputSchema.parse({
      position: 1,
      description: 'Power washing — front patio',
      quantity: '2.5',
      unitPrice: '40.00',
      amount: '100.00',
    });
    expect(parsed.position).toBe(1);
  });

  it('rejects position 0', () => {
    expect(
      invoiceLineItemInputSchema.safeParse({
        position: 0,
        description: 'x',
        quantity: '1',
        unitPrice: '1.00',
        amount: '1.00',
      }).success,
    ).toBe(false);
  });
});

describe('invoiceCreateSchema', () => {
  const base = {
    companyId: '01890000-0000-7000-8000-000000000001',
    contactId: '01890000-0000-7000-8000-000000000002',
    number: 'INV-001',
    issueDate: '2026-05-23',
    dueDate: '2026-06-22',
    subtotal: '100.00',
    total: '108.25',
    lineItems: [
      {
        position: 1,
        description: 'Service',
        quantity: '1',
        unitPrice: '100.00',
        amount: '100.00',
      },
    ],
  };

  it('accepts a minimal invoice', () => {
    expect(invoiceCreateSchema.parse(base).number).toBe('INV-001');
  });

  it('rejects an invoice with zero line items', () => {
    expect(invoiceCreateSchema.safeParse({ ...base, lineItems: [] }).success).toBe(false);
  });

  it('rejects a malformed money field', () => {
    expect(invoiceCreateSchema.safeParse({ ...base, total: 'free' }).success).toBe(false);
  });

  it('rejects a non-ISO date', () => {
    expect(invoiceCreateSchema.safeParse({ ...base, dueDate: '06/22/2026' }).success).toBe(false);
  });
});

describe('invoiceMarkPaidSchema', () => {
  it('accepts each offline method', () => {
    for (const method of ['cash', 'check', 'venmo', 'zelle', 'other']) {
      expect(invoiceMarkPaidSchema.safeParse({ method }).success).toBe(true);
    }
  });

  it('rejects stripe (webhook-only) and unknown methods', () => {
    expect(invoiceMarkPaidSchema.safeParse({ method: 'stripe' }).success).toBe(false);
    expect(invoiceMarkPaidSchema.safeParse({ method: 'paypal' }).success).toBe(false);
  });

  it('requires a method', () => {
    expect(invoiceMarkPaidSchema.safeParse({}).success).toBe(false);
  });

  it('trims a reference and coerces blank to null', () => {
    const a = invoiceMarkPaidSchema.safeParse({ method: 'check', reference: ' #1234 ' });
    expect(a.success && a.data.reference).toBe('#1234');
    const b = invoiceMarkPaidSchema.safeParse({ method: 'cash', reference: '' });
    expect(b.success && b.data.reference).toBeNull();
  });

  it('accepts an ISO paidOn and rejects a malformed one', () => {
    expect(invoiceMarkPaidSchema.safeParse({ method: 'cash', paidOn: '2026-05-20' }).success).toBe(
      true,
    );
    expect(invoiceMarkPaidSchema.safeParse({ method: 'cash', paidOn: '05/20/2026' }).success).toBe(
      false,
    );
  });
});
