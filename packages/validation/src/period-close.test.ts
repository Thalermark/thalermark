import { describe, expect, it } from 'vitest';
import { BUSINESS_TYPES } from './company.js';
import {
  COA_OWNER_EQUITY,
  COA_RETAINED_EARNINGS,
  PERIOD_CLOSE_EQUITY_LABELS,
  periodCloseCreateSchema,
  periodCloseEquityCode,
  periodCloseEquityLabel,
} from './period-close.js';

describe('periodCloseEquityCode — where a year rolls', () => {
  it('sends the two corp types to Retained Earnings', () => {
    // 3400 is the balance Form 1120 / 1120-S Schedule L actually reports, and
    // it is seeded ONLY for these two.
    expect(periodCloseEquityCode('s_corp')).toBe(COA_RETAINED_EARNINGS);
    expect(periodCloseEquityCode('c_corp')).toBe(COA_RETAINED_EARNINGS);
  });

  it('sends everyone else to owner capital', () => {
    // A sole proprietor has no accumulating earnings balance and needs none —
    // their profit is theirs the moment it's earned. 3400 isn't on their chart,
    // so closing there would post to an account that doesn't exist.
    expect(periodCloseEquityCode('sole_prop')).toBe(COA_OWNER_EQUITY);
    expect(periodCloseEquityCode('llc_single_member')).toBe(COA_OWNER_EQUITY);
    expect(periodCloseEquityCode('partnership')).toBe(COA_OWNER_EQUITY);
  });

  it('treats an uncaptured business type as a sole prop', () => {
    // Signup seeds the sole-prop chart provisionally, before the welcome wizard
    // asks — same convention as filesScheduleC.
    expect(periodCloseEquityCode(null)).toBe(COA_OWNER_EQUITY);
    expect(periodCloseEquityCode(undefined)).toBe(COA_OWNER_EQUITY);
  });

  it('only ever resolves to an account every chart actually has', () => {
    // A code that isn't on the company's chart would fail the close at posting
    // time, so the mapping must stay inside these two.
    for (const type of BUSINESS_TYPES) {
      expect([COA_OWNER_EQUITY, COA_RETAINED_EARNINGS]).toContain(periodCloseEquityCode(type));
    }
  });
});

describe('periodCloseEquityLabel — what the user reads', () => {
  it("names the destination in each entity's own words", () => {
    expect(periodCloseEquityLabel('sole_prop')).toBe("Owner's equity");
    expect(periodCloseEquityLabel('llc_single_member')).toBe("Owner's equity");
    expect(periodCloseEquityLabel('partnership')).toBe("Partners' capital");
    // The one term we don't soften — a corp owner's accountant says exactly
    // this, and matching them is the point of the feature.
    expect(periodCloseEquityLabel('s_corp')).toBe('Retained earnings');
    expect(periodCloseEquityLabel('c_corp')).toBe('Retained earnings');
  });

  it('falls back to owner equity for an uncaptured type', () => {
    expect(periodCloseEquityLabel(null)).toBe("Owner's equity");
    expect(periodCloseEquityLabel(undefined)).toBe("Owner's equity");
  });

  it('agrees with the per-type label map', () => {
    // Two ways to reach the same string (a function for loose input, a map for
    // a known BusinessType) — they must not drift apart.
    for (const type of BUSINESS_TYPES) {
      expect(periodCloseEquityLabel(type)).toBe(PERIOD_CLOSE_EQUITY_LABELS[type]);
    }
  });
});

describe('periodCloseCreateSchema', () => {
  const companyId = '0192f8a0-1b2c-7d3e-8f40-a1b2c3d4e5f6';

  it('accepts a company id and a fiscal year', () => {
    const parsed = periodCloseCreateSchema.safeParse({ companyId, fiscalYear: 2025 });
    expect(parsed.success).toBe(true);
  });

  it('rejects a non-integer or out-of-range year', () => {
    // Matches the DB CHECK; the API separately refuses a year that hasn't
    // finished yet, which needs the company's timezone and so can't live here.
    expect(periodCloseCreateSchema.safeParse({ companyId, fiscalYear: 2025.5 }).success).toBe(
      false,
    );
    expect(periodCloseCreateSchema.safeParse({ companyId, fiscalYear: 1899 }).success).toBe(false);
    expect(periodCloseCreateSchema.safeParse({ companyId, fiscalYear: 3000 }).success).toBe(false);
  });

  it('rejects a missing or malformed company id', () => {
    expect(periodCloseCreateSchema.safeParse({ fiscalYear: 2025 }).success).toBe(false);
    expect(
      periodCloseCreateSchema.safeParse({ companyId: 'not-a-uuid', fiscalYear: 2025 }).success,
    ).toBe(false);
  });
});
