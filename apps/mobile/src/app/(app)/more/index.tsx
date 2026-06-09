import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// The "More" hub — the home for screens that don't earn a top-level tab. M9
// seeds it with the items catalog (web's /settings/items) and the top-products
// report (web's /reports/top-products). M10 (company switcher + invites) and
// M11 (nav consolidation) extend this list.
type Entry = {
  href: '/more/items' | '/more/top-products';
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
};

const ENTRIES: Entry[] = [
  {
    href: '/more/items',
    icon: 'pricetags-outline',
    title: 'Products & services',
    subtitle: 'A reusable catalog you can pull into any invoice or estimate.',
  },
  {
    href: '/more/top-products',
    icon: 'bar-chart-outline',
    title: 'Top products',
    subtitle: 'Which catalog items bring in the most revenue.',
  },
];

export default function MoreHub() {
  const router = useRouter();

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">More</Text>
        <Text className="mt-2 font-serif text-3xl font-light text-ink">Catalog &amp; reports</Text>

        <View className="mt-8 space-y-4">
          {ENTRIES.map((e) => (
            <Pressable
              key={e.href}
              onPress={() => router.push(e.href)}
              className="flex-row items-center gap-4 rounded-sm border border-ink/10 bg-cream-warm p-5 active:bg-cream"
            >
              <Ionicons name={e.icon} size={24} color="#9a7b4f" />
              <View className="flex-1">
                <Text className="font-serif text-lg text-ink">{e.title}</Text>
                <Text className="mt-1 text-xs text-ink/60">{e.subtitle}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color="#0f162680" />
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
