import { describe, expect, it } from 'vitest';
import { type RawExtraction, constrainCode, normalizeExtraction } from './normalize.js';

const ALLOWED = ['6000', '6100', '7200'];

function raw(overrides: Partial<RawExtraction> = {}): RawExtraction {
  return {
    merchant: 'Home Depot',
    total: 42.5,
    expenseDate: '2026-05-20',
    taxAmount: 3.4,
    suggestedCategoryCode: '6000',
    ...overrides,
  };
}

describe('normalizeExtraction', () => {
  it('passes through a clean, fully-populated extraction', () => {
    expect(normalizeExtraction(raw(), ALLOWED)).toEqual({
      merchant: 'Home Depot',
      total: '42.50',
      expenseDate: '2026-05-20',
      taxAmount: '3.40',
      suggestedCategoryCode: '6000',
    });
  });

  it('formats money to 2 decimal places', () => {
    const r = normalizeExtraction(raw({ total: 5, taxAmount: 0 }), ALLOWED);
    expect(r.total).toBe('5.00');
    expect(r.taxAmount).toBe('0.00');
  });

  it('nulls negative or non-finite money', () => {
    const r = normalizeExtraction(raw({ total: -1, taxAmount: Number.POSITIVE_INFINITY }), ALLOWED);
    expect(r.total).toBeNull();
    expect(r.taxAmount).toBeNull();
  });

  it('trims merchant and nulls empties', () => {
    expect(normalizeExtraction(raw({ merchant: '  Acme  ' }), ALLOWED).merchant).toBe('Acme');
    expect(normalizeExtraction(raw({ merchant: '   ' }), ALLOWED).merchant).toBeNull();
  });

  it('rejects non-ISO dates', () => {
    expect(normalizeExtraction(raw({ expenseDate: '05/20/2026' }), ALLOWED).expenseDate).toBeNull();
    expect(
      normalizeExtraction(raw({ expenseDate: '2026-05-20T10:00:00Z' }), ALLOWED).expenseDate,
    ).toBeNull();
  });

  it('drops a category code that is not in the allowed set', () => {
    expect(
      normalizeExtraction(raw({ suggestedCategoryCode: '9999' }), ALLOWED).suggestedCategoryCode,
    ).toBeNull();
    expect(
      normalizeExtraction(raw({ suggestedCategoryCode: '6100' }), ALLOWED).suggestedCategoryCode,
    ).toBe('6100');
  });

  it('handles a model that returns all nulls', () => {
    const r = normalizeExtraction(
      {
        merchant: null,
        total: null,
        expenseDate: null,
        taxAmount: null,
        suggestedCategoryCode: null,
      },
      ALLOWED,
    );
    expect(r).toEqual({
      merchant: null,
      total: null,
      expenseDate: null,
      taxAmount: null,
      suggestedCategoryCode: null,
    });
  });
});

describe('constrainCode', () => {
  it('keeps a code in the allowed set, trimming whitespace', () => {
    expect(constrainCode('6100', ALLOWED)).toBe('6100');
    expect(constrainCode('  6000  ', ALLOWED)).toBe('6000');
  });

  it('nulls a hallucinated code, empty, or non-string', () => {
    expect(constrainCode('9999', ALLOWED)).toBeNull();
    expect(constrainCode('', ALLOWED)).toBeNull();
    expect(constrainCode(null, ALLOWED)).toBeNull();
    expect(constrainCode(undefined, ALLOWED)).toBeNull();
  });
});
