import { describe, expect, it } from 'vitest';
import { periodPresets, taxYearOptions } from './reports.server';

describe('periodPresets', () => {
  it('anchors every window to the given business day', () => {
    const p = Object.fromEntries(periodPresets('2026-09-01').map((x) => [x.key, x]));
    expect(p.month).toMatchObject({ from: '2026-09-01', to: '2026-09-01' });
    expect(p.quarter).toMatchObject({ from: '2026-07-01', to: '2026-09-01' });
    expect(p.ytd).toMatchObject({ from: '2026-01-01', to: '2026-09-01' });
    expect(p.lastyear).toMatchObject({ from: '2025-01-01', to: '2025-12-31' });
  });

  it('computes the quarter start for every month', () => {
    const starts = ['01', '01', '01', '04', '04', '04', '07', '07', '07', '10', '10', '10'];
    starts.forEach((q, i) => {
      const m = String(i + 1).padStart(2, '0');
      const quarter = periodPresets(`2026-${m}-15`).find((x) => x.key === 'quarter');
      expect(quarter?.from).toBe(`2026-${q}-01`);
    });
  });

  it("keeps New Year's Eve in the old year", () => {
    // At 7pm Central on Dec 31 the UTC clock already reads Jan 1, and the old
    // machine-clock code built YTD as the empty new year (TMC-302). The input
    // is now the company's own day, which cannot flip early.
    const p = Object.fromEntries(periodPresets('2026-12-31').map((x) => [x.key, x]));
    expect(p.ytd).toMatchObject({ from: '2026-01-01', to: '2026-12-31' });
    expect(p.lastyear).toMatchObject({ from: '2025-01-01', to: '2025-12-31' });
  });
});

describe('taxYearOptions', () => {
  it('offers the current company year plus three back', () => {
    expect(taxYearOptions(2026)).toEqual([2026, 2025, 2024, 2023]);
  });
});
