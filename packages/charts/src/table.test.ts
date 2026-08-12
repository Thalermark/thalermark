import { describe, expect, it } from 'vitest';
import { seriesTable } from './table.js';

// The accessible table is also the no-JavaScript chart, so it is worth more
// than a component test can give it. Built as data here, it gets asserted.

type Month = { month: string; revenue: string | null; costs: string | null };

const data: Month[] = [
  { month: '2026-01', revenue: '1200.00', costs: '300.00' },
  { month: '2026-02', revenue: null, costs: '0.00' },
];

const base = {
  data,
  x: { key: 'month' as const, label: (r: Month) => r.month, title: 'Month' },
  series: [
    { key: 'revenue' as const, label: 'Revenue' },
    { key: 'costs' as const, label: 'Costs' },
  ],
};

describe('seriesTable', () => {
  it('heads with the axis title and the human series labels', () => {
    expect(seriesTable(base).head).toEqual(['Month', 'Revenue', 'Costs']);
  });

  it('falls back to a generic header rather than the column name', () => {
    // Deriving 'month' from the key would put a raw column name on the page,
    // which apps/web/e2e/every-page.spec.ts fails the build over.
    const { x, ...rest } = base;
    const untitled = { ...rest, x: { key: x.key, label: x.label } };
    expect(seriesTable(untitled).head[0]).toBe('Category');
  });

  it('renders one row per datum, formatted', () => {
    expect(seriesTable(base).rows).toEqual([
      ['2026-01', '$1,200.00', '$300.00'],
      // The null revenue is a dash and the zero cost is a zero — the same
      // distinction the chart marks make, carried into the text fallback.
      ['2026-02', '—', '$0.00'],
    ]);
  });

  it('honours the format', () => {
    const hours = seriesTable({
      ...base,
      series: [{ key: 'revenue', label: 'Hours' }],
      format: 'hours',
    });
    expect(hours.rows[0]?.[1]).toBe('1,200h');
  });

  it('has no rows for no data, and still has a head', () => {
    const empty = seriesTable({ ...base, data: [] });
    expect(empty.rows).toEqual([]);
    expect(empty.head).toEqual(['Month', 'Revenue', 'Costs']);
  });
});
