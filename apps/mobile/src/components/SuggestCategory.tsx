import { Pressable, Text, View } from 'react-native';
import type { SuggestResult } from '../lib/categorize';

// Presentational halves of the expense forms' AI "suggest category" affordance
// (the network + mapping live in lib/categorize). Shared by both the new and
// edit expense screens so the copy + styling stay in lock-step.

// Sits in the Category field's label row (PickerField `headerRight`).
export function SuggestButton({
  suggesting,
  onPress,
}: {
  suggesting: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={suggesting}
      className="active:opacity-60 disabled:opacity-60"
    >
      <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
        {suggesting ? 'Suggesting…' : '✨ Suggest'}
      </Text>
    </Pressable>
  );
}

// Soft, non-blocking result banner under the Category field — never an error
// state for the whole form (the suggestion is optional help).
export function SuggestNotice({ result }: { result: SuggestResult }) {
  const isError = result.kind === 'error';
  const text =
    result.kind === 'applied' ? 'Suggested a category — review it and save.' : result.text;
  return (
    <View
      className={`mt-2 rounded-sm border px-3 py-2 ${
        isError ? 'border-oxblood/30 bg-oxblood/5' : 'border-gold-deep/30 bg-gold-deep/5'
      }`}
    >
      <Text className={`text-xs ${isError ? 'text-oxblood' : 'text-ink/80'}`}>{text}</Text>
    </View>
  );
}
