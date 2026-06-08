import { Redirect, Tabs, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { resolveActiveAccount } from '../../lib/active-account';
import { authClient } from '../../lib/auth-client';

// 'loading' until the session + active-account resolution settles, then:
//   'anon'   → no session, go sign in
//   'select' → authed with several memberships, none chosen → pick one
//   'ready'  → authed with an active account resolved → render the app
type Gate = 'loading' | 'anon' | 'select' | 'ready';

// The (app) group is the authed half of the mobile app. (auth) screens live
// outside it. Gating happens here rather than in the root layout so the
// (auth) flow doesn't pay the session-check round-trip on every navigation.
//
// Anon users land at `/` → resolved to (app)/index → this layout → redirect
// to /sign-in. The flow inverts after sign-in/sign-up: auth-client writes
// the bearer token, sign-in calls router.replace('/'), this layout re-runs
// (useFocusEffect refires on focus regain), sees the token, resolves the
// active account, renders Tabs.
//
// Beyond the session check we resolve an active account (mirror of web's
// hooks.server.ts): every tenant route needs `x-account-id`, so before showing
// any feature screen we must know which membership to scope to. The
// select-company screen below sets it for multi-account users; the empty 'none'
// case is folded into that screen's empty state.
export default function AppLayout() {
  const [gate, setGate] = useState<Gate>('loading');

  useFocusEffect(
    useCallback(() => {
      let active = true;
      authClient
        .getSession()
        .then(async (res) => {
          if (!active) return;
          if (!res.data?.user) {
            setGate('anon');
            return;
          }
          const account = await resolveActiveAccount();
          if (!active) return;
          // 'none' (no memberships) routes to select-company too — it owns the
          // "account isn't set up yet" copy.
          setGate(account.status === 'ok' ? 'ready' : 'select');
        })
        .catch(() => {
          if (active) setGate('anon');
        });
      return () => {
        active = false;
      };
    }, []),
  );

  if (gate === 'loading') {
    return (
      <View className="flex-1 items-center justify-center bg-cream">
        <ActivityIndicator color="#0f1626" />
      </View>
    );
  }

  if (gate === 'anon') return <Redirect href="/sign-in" />;
  if (gate === 'select') return <Redirect href="/select-company" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: '#0f1626',
        tabBarInactiveTintColor: '#0f162680',
        tabBarStyle: { backgroundColor: '#f4ede0', borderTopColor: '#0f162614' },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="customers" options={{ title: 'Customers' }} />
      {/* Routable but hidden from the tab bar — reached via redirect only. */}
      <Tabs.Screen name="select-company" options={{ href: null }} />
    </Tabs>
  );
}
