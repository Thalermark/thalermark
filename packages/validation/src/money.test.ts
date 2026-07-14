import { describe, expect, it } from 'vitest';
import {
  addMoney,
  centsToMoney,
  formatUnitPrice,
  multiplyMoney,
  priceString,
  sumMoney,
  taxOfAmount,
  toCents,
  unitPriceFromTotal,
} from './money.js';

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

  it('honours 4-decimal unit price precision (the agreed-total case)', () => {
    // $650 over 7 units: no 2dp price reaches it, but 4dp does.
    expect(multiplyMoney('7', '92.85')).toBe('649.95');
    expect(multiplyMoney('7', '92.86')).toBe('650.02');
    expect(multiplyMoney('7', '92.8571')).toBe('650.00');
    // 2dp prices are unchanged by the wider scale (back-compat).
    expect(multiplyMoney('2', '3.50')).toBe('7.00');
    expect(multiplyMoney('3', '33.3333')).toBe('100.00');
  });
});

describe('unitPriceFromTotal', () => {
  it('back-computes a 4dp unit price that multiplies back to the total', () => {
    expect(unitPriceFromTotal('650.00', '7')).toBe('92.8571');
    expect(multiplyMoney('7', unitPriceFromTotal('650.00', '7'))).toBe('650.00');
  });

  it('round-trips for awkward divisors', () => {
    for (const [total, qty] of [
      ['100.00', '3'],
      ['100.00', '6'],
      ['100.00', '7'],
      ['0.10', '3'],
      ['1000.00', '7'],
    ] as const) {
      expect(multiplyMoney(qty, unitPriceFromTotal(total, qty))).toBe(total);
    }
  });

  it('a zero or blank quantity has no per-unit price', () => {
    expect(unitPriceFromTotal('650.00', '0')).toBe('0.0000');
    expect(unitPriceFromTotal('650.00', '')).toBe('0.0000');
  });
});

describe('formatUnitPrice', () => {
  it('shows 2-4 decimals, trimming trailing zeros past the second', () => {
    expect(formatUnitPrice('10.0000')).toBe('10.00'); // legacy widened price
    expect(formatUnitPrice('92.8500')).toBe('92.85');
    expect(formatUnitPrice('92.8571')).toBe('92.8571');
    expect(formatUnitPrice('92.8570')).toBe('92.857');
    expect(formatUnitPrice('10')).toBe('10.00');
    expect(formatUnitPrice('10.5')).toBe('10.50');
    expect(formatUnitPrice('0.0000')).toBe('0.00');
  });

  it('returns unparseable input unchanged', () => {
    expect(formatUnitPrice('')).toBe('');
    expect(formatUnitPrice('bogus')).toBe('bogus');
  });
});

describe('priceString', () => {
  it('accepts up to 4 fractional digits', () => {
    for (const s of ['10', '10.00', '92.8571', '0.0001']) {
      expect(priceString.safeParse(s).success).toBe(true);
    }
  });

  it('rejects >4 digits, negatives, and non-decimals', () => {
    for (const s of ['92.85712', '-5.00', 'abc', '.50']) {
      expect(priceString.safeParse(s).success).toBe(false);
    }
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

describe('toCents / centsToMoney', () => {
  it('parses money strings to integer cents', () => {
    expect(toCents('0.00')).toBe(0);
    expect(toCents('0.05')).toBe(5);
    expect(toCents('1.00')).toBe(100);
    expect(toCents('100.10')).toBe(10010);
    expect(toCents('12.34')).toBe(1234);
  });

  it('parses a signed money string (e.g. a credit − debit SQL sum)', () => {
    expect(toCents('-5.00')).toBe(-500);
    expect(toCents('-0.01')).toBe(-1);
  });

  it('formats integer cents back to a 2-dp money string', () => {
    expect(centsToMoney(0)).toBe('0.00');
    expect(centsToMoney(5)).toBe('0.05');
    expect(centsToMoney(100)).toBe('1.00');
    expect(centsToMoney(10010)).toBe('100.10');
  });

  it('formats a negative balance with a leading minus', () => {
    expect(centsToMoney(-500)).toBe('-5.00');
    expect(centsToMoney(-1)).toBe('-0.01');
  });

  it('round-trips exactly, and summing in cents dodges the classic float drift', () => {
    // 0.1 + 0.2 in floats is 0.30000000000000004; in cents it is exact.
    const cents = ['0.10', '0.20'].reduce((s, v) => s + toCents(v), 0);
    expect(centsToMoney(cents)).toBe('0.30');
    // A long run of cents that would accumulate error as floats.
    const many = Array.from({ length: 1000 }, () => '0.01');
    expect(centsToMoney(many.reduce((s, v) => s + toCents(v), 0))).toBe('10.00');
  });
});
