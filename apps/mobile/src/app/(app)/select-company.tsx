import { COPY } from '@thalermark/brand';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type Membership, resolveActiveAccount } from '../../lib/active-account';
import { setActiveAccountId } from '../../lib/secure-store';

// Mobile mirror of apps/web's /select-company. The (app) layout redirects here
// when an authed user has several memberships and none is chosen ('select'),
// or has no memberships at all ('none' → the empty state below). Picking one
// persists the active account id and bounces home, where the layout gate
// re-runs and resolves 'ready'.
type Screen =
  | { state: 'loading' }
  | { state: 'list'; memberships: Membership[] }
  | { state: 'empty' };

export default function SelectCompany() {
  const router = useRouter();
  const [screen, setScreen] = useState<Screen>({ state: 'loading' });

  useFocusEffect(
    useCallback(() => {
      let active = true;
      resolveActiveAccount()
        .then((res) => {
          if (!active) return;
          if (res.status === 'select') {
            setScreen({ state: 'list', memberships: res.memberships });
          } else if (res.status === 'none') {
            setScreen({ state: 'empty' });
          } else {
            // Already resolved (e.g. a single membership) — nothing to pick.
            router.replace('/');
          }
        })
        .catch(() => {
          if (active) setScreen({ state: 'empty' });
        });
      return () => {
        active = false;
      };
    }, [router]),
  );

  async function onPick(accountId: string) {
    await setActiveAccountId(accountId);
    router.replace('/');
  }

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <View className="flex-1 px-6 pt-12">
        <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
          {COPY.workspace}
        </Text>
        <Text className="mt-3 font-serif text-3xl font-light text-ink">
          {COPY.selectCompany.title}
        </Text>

        {screen.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        ) : screen.state === 'empty' ? (
          <View className="mt-8 rounded-sm border border-oxblood/30 bg-oxblood/5 p-5">
            <Text className="font-medium text-oxblood">Your workspace isn't set up yet.</Text>
            <Text className="mt-2 text-sm text-ink/75">
              We couldn't find any companies linked to your sign-in. This usually means your sign-up
              didn't finish. Contact support or sign out and try again.
            </Text>
          </View>
        ) : (
          <View className="mt-8 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
            {screen.memberships.map((m, i) => (
              <View
                key={m.accountId}
                className={`flex-row items-center justify-between px-5 py-4 ${
                  i > 0 ? 'border-t border-ink/10' : ''
                }`}
              >
                <Text className="font-serif text-lg text-ink">{m.name}</Text>
                <Pressable
                  onPress={() => onPick(m.accountId)}
                  className="rounded-sm bg-ink px-4 py-2 active:bg-gold-deep"
                >
                  <Text className="text-sm font-medium text-cream">Open</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}
