import { COPY, PRODUCT_NAME, TAGLINE } from '@thalermark/brand';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { authClient, signOut } from '../../lib/auth-client';

// Authed home placeholder. The (app)/_layout has already verified the
// bearer token before this screen mounts, so we don't gate again — we just
// fetch the user record once for the "signed in as" line. Replaced with a
// real dashboard + UserMenu component (mirror of apps/web's) when the first
// MVP feature lands.
export default function Home() {
  const router = useRouter();
  const [user, setUser] = useState<{ name: string | null; email: string } | null>(null);

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
