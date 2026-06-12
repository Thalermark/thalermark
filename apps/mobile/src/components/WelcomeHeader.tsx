import { Text, View } from 'react-native';

// Step chrome for the welcome wizard — the native mirror of web's
// welcome/+layout.svelte indicator. Each step renders it at the top with its
// own number; the bars fill up to the current step. Kept tiny + presentational.
const TOTAL = 3;

export function WelcomeHeader({ step }: { step: 1 | 2 | 3 }) {
  return (
    <View>
      <View className="flex-row items-center justify-between">
        <Text className="font-serif text-xl tracking-tight text-ink">thalermark</Text>
        <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
          Step {step} of {TOTAL}
        </Text>
      </View>
      <View className="mt-4 flex-row gap-2">
        {[1, 2, 3].map((i) => (
          <View
            key={i}
            className={`h-1 flex-1 rounded-full ${i <= step ? 'bg-gold-deep' : 'bg-ink/15'}`}
          />
        ))}
      </View>
    </View>
  );
}
