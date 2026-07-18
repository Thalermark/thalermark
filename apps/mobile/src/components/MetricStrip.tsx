import { Pressable, Text, View } from 'react-native';

// Point-in-time metric tiles — the RN mirror of web's MetricStrip.svelte. A
// wrapping 2-column grid of tappable tiles: on the dashboard they navigate to a
// filtered list; on a list screen they set the filter in place. `active` marks
// the applied one (gold), `alert` tints the one wanting attention (oxblood,
// e.g. overdue > 0). `value` is the headline count; `sub` is an optional
// secondary line (e.g. a $ amount) on money-bearing buckets only.
//
// No horizontal padding of its own — callers wrap in the screen's px-6 so it
// lines up with the header and filter rows.
export type MetricTile = {
  label: string;
  value: string | number;
  sub?: string;
  onPress: () => void;
  active?: boolean;
  alert?: boolean;
};

export function MetricStrip({ tiles }: { tiles: MetricTile[] }) {
  return (
    <View className="flex-row flex-wrap gap-3">
      {tiles.map((t) => (
        <Pressable
          key={t.label}
          onPress={t.onPress}
          style={{ flexBasis: '47%' }}
          className={`grow rounded-sm border p-3 active:opacity-80 ${
            t.alert
              ? 'border-oxblood/30 bg-oxblood/5'
              : t.active
                ? 'border-gold-deep bg-gold-deep/5'
                : 'border-ink/10 bg-cream-warm'
          }`}
        >
          <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">{t.label}</Text>
          <Text className="mt-1 font-serif text-xl font-light tabular-nums text-ink">
            {t.value}
          </Text>
          {t.sub ? <Text className="mt-0.5 text-xs tabular-nums text-ink/40">{t.sub}</Text> : null}
        </Pressable>
      ))}
    </View>
  );
}
