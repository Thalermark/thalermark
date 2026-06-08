import { COPY, PRODUCT_NAME, TAGLINE } from '@thalermark/brand';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../lib/api';
import { authClient, signOut } from '../../lib/auth-client';

// Authed home placeholder. The (app)/_layout has already verified the
// bearer token + resolved an active account before this screen mounts, so we
// don't gate again — we just fetch the user record for the "signed in as" line
// and the active account's companies. The companies call is a tenant route
// (GET /api/companies, scoped by x-account-id): rendering a company name here
// is the proof the active-account foundation is wired end to end. Replaced
// with a real dashboard + UserMenu component (mirror of apps/web's) when the
// first MVP feature lands.
export default function Home() {
  const router = useRouter();
  const [user, setUser] = useState<{ name: string | null; email: string } | null>(null);
  const [companies, setCompanies] = useState<string[] | null>(null);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      authClient
        .getSession()
        .then((res) => {
          if (!active || !res.data?.user) return;
          setUser({ name: res.data.user.name ?? null, email: res.data.user.email });
        })
        .catch(() => {});
      api.api.companies
        .$get()
        .then(async (res) => {
          if (!active || !res.ok) return;
          const { companies: rows } = await res.json();
          setCompanies(rows.map((c) => c.name));
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }, []),
  );

  async function onSignOut() {
    await signOut();
    router.replace('/sign-in');
  }

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <View className="flex-1 items-center justify-center px-6">
        <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
          — Mobile shell
        </Text>
        <Text className="mt-4 font-serif text-4xl font-light text-ink">{PRODUCT_NAME}</Text>
        <Text className="mt-3 max-w-xs text-center text-ink/70">{TAGLINE}</Text>

        <View className="mt-12 w-full max-w-xs items-center space-y-4">
          <Text className="text-center text-sm text-ink/70">
            Signed in as{' '}
            <Text className="font-medium text-ink">{user?.name ?? user?.email ?? '…'}</Text>
          </Text>
          {companies && companies.length > 0 ? (
            <Text className="text-center text-sm text-ink/70">
              {companies.length > 1 ? 'Companies ' : 'Company '}
              <Text className="font-medium text-ink">{companies.join(', ')}</Text>
            </Text>
          ) : null}
          <Pressable
            onPress={onSignOut}
            className="rounded-sm border border-ink/30 px-4 py-2 active:bg-ink/5"
          >
            <Text className="font-mono text-xs uppercase tracking-widest text-ink">
              {COPY.signOut}
            </Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}
