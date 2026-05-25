import { describe, expect, it } from 'vitest';
import { createStripeBundle, decimalDollarsToCents } from './stripe.js';

describe('createStripeBundle', () => {
  it('returns null when any required value is missing', () => {
    expect(createStripeBundle({})).toBeNull();
    expect(createStripeBundle({ secretKey: 'sk_test_x' })).toBeNull();
    expect(createStripeBundle({ secretKey: 'sk_test_x', publishableKey: 'pk_test_x' })).toBeNull();
  });

  it('builds the bundle when all three are present', () => {
    const bundle = createStripeBundle({
      secretKey: 'sk_test_xxx',
      publishableKey: 'pk_test_xxx',
      webhookSecret: 'whsec_xxx',
    });
    expect(bundle).not.toBeNull();
    expect(bundle?.publishableKey).toBe('pk_test_xxx');
    expect(bundle?.webhookSecret).toBe('whsec_xxx');
    expect(bundle?.client).toBeDefined();
  });

  it('treats whitespace-only env vars as missing', () => {
    expect(
      createStripeBundle({ secretKey: '  ', publishableKey: 'pk', webhookSecret: 'whsec' }),
    ).toBeNull();
  });
});

describe('decimalDollarsToCents', () => {
  it('handles whole numbers', () => {
    expect(decimalDollarsToCents('150')).toBe(15000);
  });

  it('handles two-decimal money strings', () => {
    expect(decimalDollarsToCents('150.00')).toBe(15000);
    expect(decimalDollarsToCents('150.55')).toBe(15055);
    expect(decimalDollarsToCents('0.05')).toBe(5);
    expect(decimalDollarsToCents('0.50')).toBe(50);
  });

  it('handles single-decimal money strings', () => {
    expect(decimalDollarsToCents('10.5')).toBe(1050);
  });

  it('survives values that would lose precision via float multiplication', () => {
    expect(decimalDollarsToCents('0.10')).toBe(10);
    expect(decimalDollarsToCents('0.20')).toBe(20);
    expect(decimalDollarsToCents('0.30')).toBe(30);
  });

  it('rejects malformed input', () => {
    expect(() => decimalDollarsToCents('')).toThrow();
    expect(() => decimalDollarsToCents('abc')).toThrow();
    expect(() => decimalDollarsToCents('-1.00')).toThrow();
    expect(() => decimalDollarsToCents('1.2.3')).toThrow();
  });
});
