import { formatValue } from './format.js';
import type { ChartProps, ChartValue } from './types.js';

// The chart, as a table.
//
// Every web chart renders this alongside the marks, visually hidden. It is the
// accessible representation — the SVG is aria-hidden, so a screen reader gets
// one clear answer instead of a pile of unlabelled shapes.
//
// It is also, and less obviously, THE no-JavaScript answer. SSR is on for every
// route in this app and there are no client-only load functions, so this table
// is server-rendered unconditionally. A crawler, a reader with JS off and a
// `curl` all get the full series whatever the charting library does or does not
// manage to draw. That is why it is built here as data rather than assembled in
// markup: a pure function is unit-testable, and the fallback is too important
// to be proven only by looking at it.
export function seriesTable<Row>(
  props: Pick<ChartProps<Row>, 'data' | 'x' | 'series' | 'format'>,
): { head: string[]; rows: string[][] } {
  const { data, x, series, format } = props;

  // The axis knows how to render a tick, not what the axis is called — so the
  // header comes from `x.title` when the caller named it, and falls back to a
  // generic word rather than guessing from the key (which would be a column
  // name, and column names are what the every-page CI rule exists to catch).
  const head = [x.title ?? 'Category', ...series.map((s) => s.label)];

  const rows = data.map((row) => [
    x.label(row),
    ...series.map((s) =>
      formatValue((row as Record<string, unknown>)[s.key] as ChartValue, format),
    ),
  ]);

  return { head, rows };
}
