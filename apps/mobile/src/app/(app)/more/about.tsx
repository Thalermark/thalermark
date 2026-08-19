import { DOMAIN, PRODUCT_NAME, TAGLINE } from '@thalermark/brand';
import Constants from 'expo-constants';
import { Linking, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// App version comes from app.config.ts (extra.appVersion), baked in at build
// time from the git release tag / APP_VERSION — the version of THIS build, not a
// runtime value. Mirrors web's Settings → About.
const version = (Constants.expoConfig?.extra?.appVersion as string | undefined) ?? 'dev';

const siteUrl = `https://${DOMAIN}`;
const sourceUrl = 'https://github.com/Thalermark/thalermark';

export default function About() {
  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">More</Text>
        <Text className="mt-2 font-serif text-3xl font-light text-ink">About</Text>

        <View className="mt-8 rounded-sm border border-ink/10 bg-cream-warm">
          <View className="border-b border-ink/10 px-5 py-4">
            <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
              Overview
            </Text>
            <Text className="mt-1 text-sm text-ink-subtle">{TAGLINE}</Text>
          </View>
          <Text className="px-5 py-4 text-sm leading-relaxed text-ink/80">
            {PRODUCT_NAME} is built for people who'd rather be doing the work than the books —
            landscapers, dog sitters, power washers, independent contractors. Send an invoice in
            under a minute, snap a receipt to log an expense, and let the AI explain what's
            happening in plain English. There's a real double-entry ledger underneath, but you'll
            never see a debit or a credit — just invoices, expenses, and answers.
          </Text>
        </View>

        <View className="mt-6 rounded-sm border border-ink/10 bg-cream-warm">
          <View className="border-b border-ink/10 px-5 py-4">
            <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
              The name
            </Text>
          </View>
          <Text className="px-5 py-4 text-sm leading-relaxed text-ink/80">
            The name draws on two old words for money. The <Text className="italic">thaler</Text>{' '}
            was the 16th-century silver coin whose name became the root of the word “dollar.” A{' '}
            <Text className="italic">mark</Text> was the stamp pressed into a coin to certify it was
            genuine. Put them together and you have the idea behind the product: every transaction,
            authenticated.
          </Text>
        </View>

        <View className="mt-6 rounded-sm border border-ink/10 bg-cream-warm">
          <View className="border-b border-ink/10 px-5 py-4">
            <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
              Open source
            </Text>
          </View>
          <View className="px-5 py-4">
            <Text className="text-sm leading-relaxed text-ink/80">
              {PRODUCT_NAME} is open source, released under the GNU Affero General Public License
              v3. Read the code, self-host it, or make it your own.
            </Text>
            <Text
              className="mt-4 text-sm text-gold-deep underline"
              onPress={() => Linking.openURL(siteUrl)}
            >
              {DOMAIN}
            </Text>
            <Text
              className="mt-2 text-sm text-gold-deep underline"
              onPress={() => Linking.openURL(sourceUrl)}
            >
              Source code on GitHub
            </Text>
          </View>
        </View>

        <View className="mt-6 rounded-sm border border-ink/10 bg-cream-warm">
          <View className="border-b border-ink/10 px-5 py-4">
            <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
              Version
            </Text>
            <Text className="mt-1 text-sm text-ink-subtle">
              The release running on this device.
            </Text>
          </View>
          <View className="flex-row items-center justify-between px-5 py-4">
            <Text className="text-sm text-ink-subtle">{PRODUCT_NAME}</Text>
            <Text className="font-mono text-sm text-ink">{version}</Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
