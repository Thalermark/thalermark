import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { activePresetKey, periodPresets } from '../lib/report-periods';
import { DateField } from './DateField';

// Reporting-window picker shared by the window report screens — the RN mirror of
// web's PeriodSelector.svelte. Quick presets (This month / quarter / YTD / Last
// year) plus a custom from–to range via native date pickers. The parent owns
// from/to and refetches on change; the active preset is matched from them.
export function PeriodSelector({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}) {
  const presets = periodPresets();
  const activeKey = activePresetKey(presets, from, to);
  const [showCustom, setShowCustom] = useState(false);
  const customOpen = showCustom || activeKey === null;

  return (
    <View className="mt-6">
      <View className="flex-row flex-wrap gap-1 rounded-sm border border-ink/15 bg-cream-warm p-1">
        {presets.map((p) => (
          <Pressable
            key={p.key}
            onPress={() => onChange(p.from, p.to)}
            className={`rounded-sm px-3 py-1 ${activeKey === p.key ? 'bg-ink' : ''}`}
          >
            <Text
              className={`font-mono text-xs uppercase tracking-widest ${
                activeKey === p.key ? 'text-cream' : 'text-ink-subtle'
              }`}
            >
              {p.label}
            </Text>
          </Pressable>
        ))}
        <Pressable
          onPress={() => setShowCustom((v) => !v)}
          className={`rounded-sm px-3 py-1 ${activeKey === null ? 'bg-ink' : ''}`}
        >
          <Text
            className={`font-mono text-xs uppercase tracking-widest ${
              activeKey === null ? 'text-cream' : 'text-ink-subtle'
            }`}
          >
            Custom
          </Text>
        </Pressable>
      </View>

      {customOpen ? (
        <View className="mt-3 flex-row gap-3">
          <View className="flex-1">
            <DateField label="From" value={from} onChange={(d) => onChange(d, to)} />
          </View>
          <View className="flex-1">
            <DateField label="To" value={to} onChange={(d) => onChange(from, d)} />
          </View>
        </View>
      ) : null}
    </View>
  );
}
