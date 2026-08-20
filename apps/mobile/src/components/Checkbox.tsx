import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text } from 'react-native';

// Checkbox-style toggle (Ionicons square ↔ checkbox), the native equivalent of
// the web's <input type="checkbox">. Used by the business settings + the
// invoice/estimate from-block "show this on the document" toggles. `className`
// is appended so callers control spacing (e.g. mt-*).
export function Checkbox({
  label,
  value,
  onToggle,
  className,
}: {
  label: string;
  value: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <Pressable onPress={onToggle} className={`flex-row items-center gap-3 ${className ?? ''}`}>
      <Ionicons
        name={value ? 'checkbox' : 'square-outline'}
        size={22}
        className={value ? 'text-gold-deep' : 'text-ink-subtle'}
      />
      <Text className="text-sm text-ink">{label}</Text>
    </Pressable>
  );
}
