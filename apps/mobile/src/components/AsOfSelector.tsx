import { View } from 'react-native';
import { DateField } from './DateField';

// Single as-of date picker for the point-in-time reports (balance sheet, A/R
// aging) — the RN mirror of web's AsOfSelector.svelte.
export function AsOfSelector({
  asOf,
  onChange,
}: {
  asOf: string;
  onChange: (asOf: string) => void;
}) {
  return (
    <View className="mt-6 w-1/2">
      <DateField label="As of" value={asOf} onChange={onChange} />
    </View>
  );
}
