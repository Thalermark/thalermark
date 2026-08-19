import { Pressable, ScrollView, Text } from 'react-native';

// Horizontal single-select chip row for a list filter (e.g. invoice status).
// The RN equivalent of the web filter <select>: value '' is the leading "All"
// chip. Tapping a chip flips the active value; the list screen reloads page 1
// when its fetchPage closes over the new value.
export function FilterChips({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2 px-6"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value || 'all'}
            onPress={() => onChange(o.value)}
            className={`rounded-full border px-3 py-1.5 ${
              active ? 'border-ink bg-ink' : 'border-ink/20 bg-cream-warm'
            }`}
          >
            <Text className={`text-xs font-medium ${active ? 'text-cream' : 'text-ink-muted'}`}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
