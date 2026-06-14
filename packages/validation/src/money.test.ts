import { describe, expect, it } from 'vitest';
import { addMoney, multiplyMoney, sumMoney, taxOfAmount } from './money.js';

describe('multiplyMoney', () => {
  it('multiplies whole numbers', () => {
    expect(multiplyMoney('2', '3.50')).toBe('7.00');
  });

  it('handles fractional quantity', () => {
    expect(multiplyMoney('1.5', '10')).toBe('15.00');
  });

  it('truncation past 2 decimals rounds half-away-from-zero', () => {
    expect(multiplyMoney('0.3333', '10')).toBe('3.33');
    expect(multiplyMoney('0.005', '1')).toBe('0.01');
    expect(multiplyMoney('0.004', '1')).toBe('0.00');
  });

  it('honours full quantity precision (4 decimals)', () => {
    expect(multiplyMoney('1.2345', '100')).toBe('123.45');
    expect(multiplyMoney('0.0001', '1.00')).toBe('0.00');
  });

  it('empty inputs read as zero', () => {
    expect(multiplyMoney('', '5')).toBe('0.00');
    expect(multiplyMoney('1', '')).toBe('0.00');
    expect(multiplyMoney('', '')).toBe('0.00');
  });

  it('malformed inputs read as zero (schema catches them downstream)', () => {
    expect(multiplyMoney('ten', '5')).toBe('0.00');
    expect(multiplyMoney('1', '-5.00')).toBe('0.00');
    expect(multiplyMoney('1', '5.00abc')).toBe('0.00');
    expect(sumMoney(['1.00', 'bogus', '2.00'])).toBe('3.00');
  });

  it('large values stay exact', () => {
    expect(multiplyMoney('999999999999', '1.00')).toBe('999999999999.00');
  });
});

describe('sumMoney', () => {
  it('empty list returns zero', () => {
    expect(sumMoney([])).toBe('0.00');
  });

  it('sums to two decimals', () => {
    expect(sumMoney(['1.00', '2.00', '3.00'])).toBe('6.00');
    expect(sumMoney(['0.10', '0.20'])).toBe('0.30');
  });

  it('handles ragged input precision', () => {
    expect(sumMoney(['1', '2.50', '0.05'])).toBe('3.55');
  });

  it('treats empty strings as zero', () => {
    expect(sumMoney(['1.00', '', '2.00'])).toBe('3.00');
  });

  it('large sums stay exact (no FP drift)', () => {
    const xs = Array.from({ length: 10000 }, () => '0.10');
    expect(sumMoney(xs)).toBe('1000.00');
  });
});

describe('addMoney', () => {
  it('adds two values', () => {
    expect(addMoney('10.00', '0.50')).toBe('10.50');
  });

  it('treats empty b as zero (tax-not-entered case)', () => {
    expect(addMoney('10.00', '')).toBe('10.00');
  });

  it('treats empty a as zero', () => {
    expect(addMoney('', '5.00')).toBe('5.00');
  });
});

describe('taxOfAmount', () => {
  it('computes a whole-percent rate', () => {
    expect(taxOfAmount('100.00', '10')).toBe('10.00');
    expect(taxOfAmount('120.00', '8.25')).toBe('9.90');
  });

  it('honours full 4-decimal rate precision', () => {
    expect(taxOfAmount('100.00', '8.8750')).toBe('8.88');
    expect(taxOfAmount('1000.00', '8.8750')).toBe('88.75');
  });

  it('rounds half-away-from-zero to the cent', () => {
    // 1.00 × 0.5% = 0.005 → 0.01
    expect(taxOfAmount('1.00', '0.5')).toBe('0.01');
    // 10.10 × 8.25% = 0.83325 → 0.83
    expect(taxOfAmount('10.10', '8.25')).toBe('0.83');
  });

  it('a zero rate or zero amount yields zero tax', () => {
    expect(taxOfAmount('100.00', '0')).toBe('0.00');
    expect(taxOfAmount('0.00', '8.25')).toBe('0.00');
  });

  it('empty / malformed inputs read as zero (schema catches them downstream)', () => {
    expect(taxOfAmount('', '8.25')).toBe('0.00');
    expect(taxOfAmount('100.00', '')).toBe('0.00');
    expect(taxOfAmount('100.00', 'bogus')).toBe('0.00');
  });

  it('large amounts stay exact (no FP drift)', () => {
    expect(taxOfAmount('999999999999.00', '10')).toBe('99999999999.90');
  });
});
