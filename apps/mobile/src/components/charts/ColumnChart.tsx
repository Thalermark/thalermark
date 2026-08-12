import {
  type ColumnChartProps,
  formatValue,
  maxValue,
  toNumber,
  toneForIndex,
} from '@thalermark/charts';
import { Text, View } from 'react-native';
import { Bar, CartesianChart } from 'victory-native';
import { toneColor } from './tone';

// Vertical bars over a categorical or time axis — the mobile half of the
// vocabulary, sharing ColumnChartProps with the Svelte implementation so a
// divergence between the two is a compile error rather than a discovery.
//
// THE TICK LABELS ARE RN <Text>, NOT DRAWN BY SKIA, and that is not a
// stylistic preference. victory-native's axis labels need an SkFont, and this
// app loads no custom fonts at all — there is no useFonts call anywhere in
// apps/mobile/src and no font files in assets, so `font-serif` and `font-mono`
// already fall back to system faces everywhere else. Handing Skia a font it
// does not have draws nothing. Rendering the ticks as ordinary Text also keeps
// them on the same `font-mono text-[10px] uppercase tracking-wide text-ink/50`
// as the web ticks and as the chart this replaces. The canvas draws marks;
// Thalermark typography draws words.
//
// The label row is laid out with the same flex-1 columns as the bars, so the
// two cannot drift — the same guarantee the web version gets from sharing a
// band scale.
export function ColumnChart<Row extends Record<string, unknown>>({
  data,
  x,
  series,
  caption,
  format = 'money',
  height = 192,
  empty,
}: ColumnChartProps<Row>) {
  const rows = [...data];

  if (rows.length === 0) {
    return <Text className="mt-8 text-ink/70">{empty ?? 'Nothing to show for this period.'}</Text>;
  }

  // One shared ceiling across every series so two series stay comparable by
  // eye. null (nothing known) is distinct from 0 (a real flat chart).
  const ceiling = maxValue(rows.flatMap((row) => series.map((s) => row[s.key] as string | null)));

  // victory-native wants numbers. The conversion happens here, at the boundary,
  // and a null becomes a MISSING KEY rather than a zero — a bar that is not
  // drawn, instead of a bar of height nothing that reads as a recorded zero.
  const points = rows.map((row, index) => {
    const point: Record<string, number> = { index };
    for (const s of series) {
      const n = toNumber(row[s.key] as string | null);
      if (n !== null) point[s.key] = n;
    }
    return point;
  });

  return (
    // The canvas is decorative: every value in it is also in the label row and
    // the rows beneath the chart, so a screen reader gets the caption and then
    // the real content rather than a wall of unlabelled shapes.
    <View accessible accessibilityLabel={caption}>
      <View style={{ height }} importantForAccessibility="no-hide-descendants">
        <CartesianChart
          data={points}
          xKey="index"
          yKeys={series.map((s) => s.key) as never}
          domain={{ y: [0, ceiling && ceiling > 0 ? ceiling : 1] }}
        >
          {({ points: rendered, chartBounds }) =>
            series.map((s, seriesIndex) => (
              <Bar
                key={s.key}
                points={(rendered as Record<string, never>)[s.key]}
                chartBounds={chartBounds}
                color={toneColor(s.tone ?? toneForIndex(seriesIndex))}
                roundedCorners={{ topLeft: 2, topRight: 2 }}
                barWidth={undefined}
              />
            ))
          }
        </CartesianChart>
      </View>

      <View className="mt-2 flex-row gap-1">
        {rows.map((row) => (
          <Text
            // Keyed on the axis VALUE, not the formatted tick and not the index:
            // two months can render the same short label ('Jan' in a multi-year
            // window) but never share an underlying key.
            key={String(row[x.key])}
            className="flex-1 text-center font-mono text-[10px] uppercase tracking-wide text-ink/50"
            numberOfLines={1}
          >
            {x.label(row)}
          </Text>
        ))}
      </View>
    </View>
  );
}

// Re-exported so a screen can render the same figures as text beside the chart
// without importing the formatting rules separately.
export { formatValue };
