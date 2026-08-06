import { describe, expect, it } from 'vitest';
import {
  MAX_MILES_PER_TRIP,
  STANDARD_MILEAGE_RATES,
  mileageTripCreateSchema,
  mileageValue,
  standardMileageRateFor,
  summariseMileage,
} from './mileage.js';

describe('standardMileageRateFor', () => {
  // THE test that exists because of the bug. The IRS split 2026 mid-year, so a
  // year-keyed rate map misprices every trip in the back half of the year we are
  // currently in. Both sides of the boundary, to the day.
  it('reads both sides of the 2026 mid-year split', () => {
    expect(standardMileageRateFor('2026-06-30')).toBe('0.7250');
    expect(standardMileageRateFor('2026-07-01')).toBe('0.7600');
  });

  // The precedent that proves the first one is not a one-off.
  it('reads both sides of the 2022 mid-year split', () => {
    expect(standardMileageRateFor('2022-06-30')).toBe('0.5850');
    expect(standardMileageRateFor('2022-07-01')).toBe('0.6250');
  });

  it('reads the whole-year rates', () => {
    expect(standardMileageRateFor('2023-03-15')).toBe('0.6550');
    expect(standardMileageRateFor('2024-11-30')).toBe('0.6700');
    expect(standardMileageRateFor('2025-01-01')).toBe('0.7000');
    expect(standardMileageRateFor('2025-12-31')).toBe('0.7000');
  });

  // Falling back to last year's rate would be self-consistent, untestable
  // against itself, and wrong on a filed return.
  it('returns null past the end of the table rather than inheriting a rate', () => {
    expect(standardMileageRateFor('2027-01-01')).toBeNull();
    expect(standardMileageRateFor('2030-06-15')).toBeNull();
  });

  it('returns null before the table starts', () => {
    expect(standardMileageRateFor('2021-12-31')).toBeNull();
  });
});

describe('STANDARD_MILEAGE_RATES table', () => {
  it('is ordered, non-overlapping, and gapless', () => {
    for (const [i, band] of STANDARD_MILEAGE_RATES.entries()) {
      expect(band.from <= band.through).toBe(true);
      const next = STANDARD_MILEAGE_RATES[i + 1];
      if (!next) continue;
      // Strictly ascending, and the next band starts the very next day — a gap
      // would silently turn real trips into unrated ones.
      expect(next.from > band.through).toBe(true);
      const dayAfter = new Date(`${band.through}T00:00:00.000Z`);
      dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
      expect(next.from).toBe(dayAfter.toISOString().slice(0, 10));
    }
  });

  it('quotes every rate at 4dp so multiplyMoney needs no parsing', () => {
    for (const band of STANDARD_MILEAGE_RATES) {
      expect(band.rate).toMatch(/^\d+\.\d{4}$/);
    }
  });
});

describe('mileageValue', () => {
  it('values a trip at the rate in force on its own date', () => {
    // 24.5 miles x $0.76 = $18.62
    expect(mileageValue('24.5000', '2026-07-15')).toBe('18.62');
    // The same drive one month earlier is worth less, because the rate was.
    expect(mileageValue('24.5000', '2026-06-15')).toBe('17.76');
  });

  it('rounds half away from zero, like every other money path', () => {
    // 10.007 x 0.70 = 7.0049 → 7.00
    expect(mileageValue('10.0070', '2025-05-01')).toBe('7.00');
    // 15.05 x 0.70 = 10.535 → 10.54
    expect(mileageValue('15.0500', '2025-05-01')).toBe('10.54');
  });

  it('is null on an unrated date', () => {
    expect(mileageValue('100.0000', '2027-03-01')).toBeNull();
  });
});

describe('summariseMileage', () => {
  it('values each trip separately across a rate boundary', () => {
    const summary = summariseMileage([
      { miles: '100.0000', tripDate: '2026-06-30' }, // x 0.7250 = 72.50
      { miles: '100.0000', tripDate: '2026-07-01' }, // x 0.7600 = 76.00
    ]);
    expect(summary.tripCount).toBe(2);
    expect(summary.miles).toBe('200.0000');
    expect(summary.amount).toBe('148.50');
    expect(summary.unratedMiles).toBe('0.0000');
    // The whole point: totalMiles x either single rate would be 145.00 or
    // 152.00, and both are wrong.
    expect(summary.amount).not.toBe('145.00');
    expect(summary.amount).not.toBe('152.00');
  });

  it('sums miles at 4dp without truncating tenths', () => {
    const summary = summariseMileage([
      { miles: '0.1000', tripDate: '2025-01-01' },
      { miles: '0.2500', tripDate: '2025-01-01' },
      { miles: '12.3456', tripDate: '2025-01-01' },
    ]);
    expect(summary.miles).toBe('12.6956');
  });

  it('separates unrated miles from the deduction', () => {
    const summary = summariseMileage([
      { miles: '50.0000', tripDate: '2025-06-01' }, // rated: 35.00
      { miles: '30.0000', tripDate: '2027-06-01' }, // no published rate
    ]);
    expect(summary.miles).toBe('80.0000');
    expect(summary.amount).toBe('35.00');
    expect(summary.unratedMiles).toBe('30.0000');
  });

  it('handles the empty case', () => {
    expect(summariseMileage([])).toEqual({
      tripCount: 0,
      miles: '0.0000',
      amount: '0.00',
      unratedMiles: '0.0000',
    });
  });
});

describe('mileageTripCreateSchema', () => {
  const valid = {
    companyId: '018f0000-0000-7000-8000-000000000001',
    tripDate: '2026-07-15',
    miles: '24.5',
    purpose: 'Drove to the Miller place',
  };

  it('accepts a minimal trip with no job and no vehicle', () => {
    expect(mileageTripCreateSchema.safeParse(valid).success).toBe(true);
  });

  it('requires a purpose — the unsubstantiated deduction is the one disallowed', () => {
    expect(mileageTripCreateSchema.safeParse({ ...valid, purpose: '' }).success).toBe(false);
    expect(mileageTripCreateSchema.safeParse({ ...valid, purpose: '   ' }).success).toBe(false);
    const { purpose: _omitted, ...noPurpose } = valid;
    expect(mileageTripCreateSchema.safeParse(noPurpose).success).toBe(false);
  });

  it('rejects zero, negative, and typo-sized mileage', () => {
    expect(mileageTripCreateSchema.safeParse({ ...valid, miles: '0' }).success).toBe(false);
    expect(mileageTripCreateSchema.safeParse({ ...valid, miles: '-5' }).success).toBe(false);
    expect(
      mileageTripCreateSchema.safeParse({ ...valid, miles: String(MAX_MILES_PER_TRIP + 1) })
        .success,
    ).toBe(false);
  });

  it('rejects a malformed date', () => {
    expect(mileageTripCreateSchema.safeParse({ ...valid, tripDate: '15/07/2026' }).success).toBe(
      false,
    );
  });
});
