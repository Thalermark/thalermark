import Constants from 'expo-constants';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// App version comes from app.config.ts (extra.appVersion), baked in at build
// time from the git release tag / APP_VERSION — the version of THIS build, not a
// runtime value. Mirrors web's Settings → About.
const version = (Constants.expoConfig?.extra?.appVersion as string | undefined) ?? 'dev';

export default function About() {
  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">More</Text>
        <Text className="mt-2 font-serif text-3xl font-light text-ink">About</Text>

        <View className="mt-8 rounded-sm border border-ink/10 bg-cream-warm">
          <View className="border-b border-ink/10 px-5 py-4">
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">Version</Text>
            <Text className="mt-1 text-sm text-ink/60">The release running on this device.</Text>
          </View>
          <View className="flex-row items-center justify-between px-5 py-4">
            <Text className="text-sm text-ink/60">Thalermark</Text>
            <Text className="font-mono text-sm text-ink">{version}</Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
