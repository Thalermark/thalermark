import { estimatePasswordStrength } from '@thalermark/validation';
import { Text, View } from 'react-native';

// Band index -> segment fill + text color (mobile palette names; web uses the
// equivalent semantic tokens). Shares the scorer with web so verdicts match.
const FILLS = ['bg-oxblood', 'bg-copper', 'bg-gold-deep', 'bg-sage'];
const TEXTS = ['text-oxblood', 'text-copper', 'text-gold-deep', 'text-sage'];

export function PasswordStrength({ password }: { password: string }) {
  if (password.length === 0) return null;
  const { score, label } = estimatePasswordStrength(password);

  return (
    <View className="mt-3">
      <View className="flex-row gap-1">
        {[0, 1, 2, 3].map((i) => (
          <View
            key={i}
            className={`h-1 flex-1 rounded-full ${i <= score ? FILLS[score] : 'bg-ink/15'}`}
          />
        ))}
      </View>
      <Text className={`mt-2 font-mono text-xs uppercase tracking-widest ${TEXTS[score]}`}>
        {label}
      </Text>
      {score < 3 ? (
        <Text className="mt-1 text-xs text-ink/55">
          A few random words make the strongest password.
        </Text>
      ) : null}
    </View>
  );
}
