import type { LineItemType } from '@thalermark/validation';
import { Pressable, Text, View } from 'react-native';

// Per-line product/service selector shared by the invoice / estimate / recurring
// line-item forms — the RN mirror of web's per-line <select name="li_type">.
// Drives the hidden-ledger revenue split (Service 4000 / Product 4100); copied
// from the catalog item on pick, editable per line. The parent owns the row
// state; this is dumb (like TaxRow).
const OPTIONS: { value: LineItemType; label: string }[] = [
  { value: 'service', label: 'Service' },
  { value: 'product', label: 'Product' },
];

export function TypeRow({
  value,
  onSelect,
}: {
  value: LineItemType;
  onSelect: (t: LineItemType) => void;
}) {
  return (
    <View className="mt-2">
      <Text className="font-mono text-[10px] uppercase tracking-widest text-ink/50">Type</Text>
      <View className="mt-1 flex-row gap-2">
        {OPTIONS.map((o) => {
          const selected = o.value === value;
          return (
            <Pressable
              key={o.value}
              onPress={() => onSelect(o.value)}
              className={`rounded-sm border px-3 py-1 ${selected ? 'border-gold-deep bg-gold-deep/10' : 'border-ink/15 bg-cream'}`}
            >
              <Text className={`text-xs ${selected ? 'text-gold-deep' : 'text-ink/70'}`}>
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
