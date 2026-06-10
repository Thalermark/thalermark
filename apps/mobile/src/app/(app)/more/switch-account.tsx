import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Membership } from '../../../lib/active-account';
import { api } from '../../../lib/api';
import { getActiveAccountId, setActiveAccountId } from '../../../lib/secure-store';

// In-app account switcher — the mobile equivalent of web's UserMenu account
// switch. Distinct from (app)/select-company (the gate screen, which bounces
// home the moment a valid choice is stored): this one always lists every
// membership and marks the active one, so a multi-account user can re-pick.
// Reached from the More hub, which only surfaces it when memberships > 1.
type SwitchState =
  | { state: 'loading' }
  | { state: 'ready'; memberships: Membership[]; activeId: string | null }
  | { state: 'error' };

export default function SwitchAccount() {
  const router = useRouter();
  const [screen, setScreen] = useState<SwitchState>({ state: 'loading' });

  useFocusEffect(
    useCallback(() => {
      let active = true;
      Promise.all([api.api.me.$get(), getActiveAccountId()])
        .then(async ([res, activeId]) => {
          if (!active) return;
          if (!res.ok) {
            setScreen({ state: 'error' });
            return;
          }
          const { memberships } = await res.json();
          setScreen({ state: 'ready', memberships, activeId });
        })
        .catch(() => {
          if (active) setScreen({ state: 'error' });
        });
      return () => {
        active = false;
      };
    }, []),
  );

  // Switch then bounce home: the layout gate + each tab's focus effect refetch
  // against the new x-account-id, so the whole app re-scopes to the new account.
  async function onPick(accountId: string) {
    if (screen.state === 'ready' && accountId === screen.activeId) return;
    await setActiveAccountId(accountId);
    router.replace('/');
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Pressable onPress={() => router.push('/more')}>
          <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">← More</Text>
        </Pressable>
        <Text className="mt-3 font-serif text-3xl font-light text-ink">Switch workspace</Text>
        <Text className="mt-3 text-sm text-ink/60">
          Pick which workspace to work in. Everything — invoices, customers, the dashboard —
          re-scopes to your choice.
        </Text>

        {screen.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        ) : screen.state === 'error' ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load your workspaces.</Text>
        ) : (
          <View className="mt-8 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
            {screen.memberships.map((m, i) => {
              const isActive = m.accountId === screen.activeId;
              return (
                <Pressable
                  key={m.accountId}
                  onPress={() => onPick(m.accountId)}
                  disabled={isActive}
                  className={`flex-row items-center justify-between px-5 py-4 active:bg-cream ${
                    i > 0 ? 'border-t border-ink/10' : ''
                  }`}
                >
                  <Text className="font-serif text-lg text-ink">{m.name}</Text>
                  {isActive ? (
                    <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
                      Current
                    </Text>
                  ) : (
                    <Text className="rounded-sm bg-ink px-4 py-2 text-sm font-medium text-cream">
                      Switch
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
