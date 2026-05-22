import { PRODUCT_NAME, TAGLINE } from '@thalermark/brand';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Phase 6.1 placeholder home. Proves the build chain: Expo + NativeWind +
// @thalermark/brand tokens reach the rendered surface. Real auth + tab nav
// land in later slices.
export default function Home() {
  return (
    <SafeAreaView className="flex-1 bg-cream">
      <View className="flex-1 items-center justify-center px-6">
        <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
          — Mobile shell
        </Text>
        <Text className="mt-4 font-serif text-4xl font-light text-ink">{PRODUCT_NAME}</Text>
        <Text className="mt-3 max-w-xs text-center text-ink/70">{TAGLINE}</Text>
      </View>
    </SafeAreaView>
  );
}
