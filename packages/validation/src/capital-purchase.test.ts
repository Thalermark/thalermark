import { describe, expect, it } from 'vitest';
import { capitalPurchaseCreateSchema, loanPaymentSchema } from './capital-purchase.js';

const COMPANY = '11111111-1111-4111-8111-111111111111';

const base = {
  companyId: COMPANY,
  description: 'Mower',
  amount: '3600.00',
  purchaseDate: '2026-04-01',
  taxTreatment: 'deduct_now' as const,
};

describe('capitalPurchaseCreateSchema', () => {
  it('accepts a paid-in-full purchase with no down payment', () => {
    const parsed = capitalPurchaseCreateSchema.safeParse({ ...base, funding: 'paid_in_full' });
    expect(parsed.success).toBe(true);
  });

  it('accepts a financed purchase with a partial down payment', () => {
    const parsed = capitalPurchaseCreateSchema.safeParse({
      ...base,
      funding: 'financed',
      downPayment: '600.00',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a financed purchase with no down payment', () => {
    const parsed = capitalPurchaseCreateSchema.safeParse({ ...base, funding: 'financed' });
    expect(parsed.success).toBe(true);
  });

  it('rejects a financed down payment that covers the whole cost', () => {
    const parsed = capitalPurchaseCreateSchema.safeParse({
      ...base,
      funding: 'financed',
      downPayment: '3600.00',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a paid-in-full down payment that differs from the amount', () => {
    const parsed = capitalPurchaseCreateSchema.safeParse({
      ...base,
      funding: 'paid_in_full',
      downPayment: '600.00',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown tax treatment', () => {
    const parsed = capitalPurchaseCreateSchema.safeParse({
      ...base,
      funding: 'paid_in_full',
      taxTreatment: 'magic',
    });
    expect(parsed.success).toBe(false);
  });

  it('requires a description', () => {
    const parsed = capitalPurchaseCreateSchema.safeParse({
      ...base,
      description: '  ',
      funding: 'paid_in_full',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('loanPaymentSchema', () => {
  it('accepts a payment with no interest (defaults to 0)', () => {
    const parsed = loanPaymentSchema.safeParse({ amount: '300.00', paidOn: '2026-05-01' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.interest).toBe('0');
  });

  it('accepts a payment with an interest split', () => {
    const parsed = loanPaymentSchema.safeParse({
      amount: '300.00',
      interest: '20.00',
      paidOn: '2026-05-01',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects interest greater than the payment', () => {
    const parsed = loanPaymentSchema.safeParse({
      amount: '300.00',
      interest: '400.00',
      paidOn: '2026-05-01',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a zero payment', () => {
    const parsed = loanPaymentSchema.safeParse({ amount: '0', paidOn: '2026-05-01' });
    expect(parsed.success).toBe(false);
  });
});
