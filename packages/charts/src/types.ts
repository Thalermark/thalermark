// The chart vocabulary — shared by web and mobile, implemented twice.
//
// WHY THIS PACKAGE HOLDS TYPES AND NOT COMPONENTS. Both Tailwind configs scan
// only their own app: apps/web/tailwind.config.ts globs `./src/**/*`, and
// apps/mobile's does the same. A .svelte or .tsx file living here is outside
// both, so every utility class in it would produce NO CSS — and it would often
// look fine in dev, because a sibling app file happens to have emitted the same
// class already. That is the worst failure mode available: correct-looking
// locally, blank in production, invisible to typecheck.
//
// The two implementations share no runtime anyway (Svelte snippets vs React
// render props, SVG DOM vs a Skia canvas). What they genuinely share is the
// SHAPE, and a type is exactly the right way to share a shape. Both sides
// declare their props as the same imported type, so `pnpm typecheck` fails on
// whichever platform has not implemented a new prop.

// A value as it crosses the API: a decimal string, or null.
//
// null means "we do not know". It is NEVER zero, and nothing in this module may
// coerce it into one. Rendering a null margin as $0.00 once told a landscaper he
// had lost money on a job — see the comment at
// apps/web/src/routes/(app)/reports/job-margin/+page.svelte:182-188. The whole
// reason `toNumber` and `formatValue` live here rather than in each chart is so
// that lesson is encoded once, in a file with tests.
export type ChartValue = string | null;

// What a series MEANS, not what colour it is.
//
// A developer names the meaning once and each platform resolves it: web emits a
// Tailwind class that resolves to `rgb(var(--token))`, so the existing `.dark`
// remap re-themes every chart with no JavaScript; mobile resolves to a hex from
// @thalermark/brand. No prop anywhere in this vocabulary accepts a colour —
// that is what keeps the two clients from drifting and what stops mobile
// gaining a fifth hand-typed hex.
export type SeriesTone =
  | 'primary' // the subject of the chart
  | 'secondary' // the comparison series
  | 'positive' // money in, work won, paid on time
  | 'negative' // money out, work lost, overdue
  | 'neutral' // context, not the point
  | 'muted'; // the track behind a bar

export type ValueFormat = 'money' | 'percent' | 'count' | 'hours';

export type ChartSeries<Row> = {
  key: Extract<keyof Row, string>;
  // What a person calls it. Appears in the legend, the tooltip and the
  // accessible table — and the accessible table is real text on the page, so
  // apps/web/e2e/every-page.spec.ts:49-54 scans it and fails CI on a leaked
  // column name. A raw key here is a red build, by design.
  label: string;
  tone?: SeriesTone;
};

export type ChartAxis<Row> = {
  key: Extract<keyof Row, string>;
  // Human tick text for one row, e.g. (r) => 'Jan 2026'.
  //
  // Required, and deliberately not defaulted to String(row[key]). The chart
  // this vocabulary replaces prints a bare 'Jan' with no year
  // (reports/revenue-over-time/+page.svelte:66), so a window spanning a year end
  // reads 'Jan … Dec Jan … Dec' with nothing to tell them apart. Making the
  // caller write the tick makes that omission a choice rather than a default.
  label: (row: Row) => string;
  // Heading for this axis's column in the accessible table, e.g. 'Month'.
  // Optional; falls back to a generic word rather than being derived from
  // `key`, since a derived header would be a raw column name — exactly what
  // the every-page CI rule exists to catch.
  title?: string;
};

export type ChartProps<Row> = {
  data: readonly Row[];
  x: ChartAxis<Row>;
  series: readonly ChartSeries<Row>[];
  // One sentence a screen-reader user can act on. Becomes the <caption> of the
  // accessible table on web and the accessibilityLabel on mobile. Required —
  // no chart ships without one.
  caption: string;
  format?: ValueFormat;
  // px on web, dp on mobile. The platform defaults differ on purpose (224 vs
  // 192) because they are the heights of the charts being replaced, so the
  // retrofit is faithful rather than a redesign smuggled in.
  height?: number;
  // Copy shown instead of an empty axis frame. An empty chart is a worse
  // answer than a sentence saying there is nothing to show.
  empty?: string;
};

export type ColumnChartProps<Row> = ChartProps<Row>;
export type BarChartProps<Row> = ChartProps<Row> & { max?: number };
export type LineChartProps<Row> = ChartProps<Row> & { area?: boolean };

// A sparkline has no axis to carry a name, so it takes one directly.
export type SparklineProps = {
  values: readonly ChartValue[];
  label: string;
  tone?: SeriesTone;
  height?: number;
};

// Not a chart — the proportional bar that lives inside a table cell.
//
// It is in this vocabulary so a developer thinks in one place, and it is
// deliberately NOT built on the charting library: three of its call sites are
// table rows, and sales-by-customer renders up to 25 of them. A scale-owning
// chart component per row, each tracking its own dimensions, is a real
// regression over a div with a width percentage. A share bar is a table
// affordance that happens to be shaped like data.
export type ShareBarProps = {
  // 0..1, not 0..100. Clamped by the implementation.
  value: number;
  tone?: SeriesTone;
  showPercent?: boolean;
};
