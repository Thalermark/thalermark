import type { ShareBarProps } from '@thalermark/charts';
import { Text, View } from 'react-native';
import { toneColor } from './tone';

// The proportional bar that lives in a report row.
//
// Moved here verbatim from ReportLayout.tsx so "show a proportion" has one home
// on both clients, and so it shares the tone vocabulary with the real charts.
// Like its web twin it is NOT built on the charting library: a share bar has no
// axis, no scale and no second dimension, and instantiating a Skia canvas per
// row of a report list would be a real regression for a rounded rectangle.
//
// The one API change from the original: it takes 0..1 rather than 0..100, which
// is the shape the shared ShareBarProps type defines and what the web component
// takes. Both call sites divide at the boundary.
export function ShareBar({ value, tone = 'primary', showPercent = true }: ShareBarProps) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <View className="mt-2 flex-row items-center gap-2">
      <View className="h-2 flex-1 overflow-hidden rounded-full bg-ink/10">
        <View
          className="h-full rounded-full"
          style={{ width: `${pct}%`, backgroundColor: toneColor(tone) }}
        />
      </View>
      {showPercent ? (
        <Text className="w-9 text-right font-mono text-xs tabular-nums text-ink/50">
          {Math.round(pct)}%
        </Text>
      ) : null}
    </View>
  );
}
