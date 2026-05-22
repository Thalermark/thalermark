import { Redirect, Tabs, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { authClient } from '../../lib/auth-client';

type Session = 'loading' | 'authed' | 'anon';

// The (app) group is the authed half of the mobile app. (auth) screens live
// outside it. Gating happens here rather than in the root layout so the
// (auth) flow doesn't pay the session-check round-trip on every navigation.
//
// Anon users land at `/` → resolved to (app)/index → this layout → redirect
// to /sign-in. The flow inverts after sign-in/sign-up: auth-client writes
// the bearer token, sign-in calls router.replace('/'), this layout re-runs
// (useFocusEffect refires on focus regain), sees the token, renders Tabs.
export default function AppLayout() {
  const [session, setSession] = useState<Session>('loading');

  useFocusEffect(
    useCallback(() => {
      let active = true;
      authClient
        .getSession()
        .then((res) => {
          if (!active) return;
          setSession(res.data?.user ? 'authed' : 'anon');
        })
        .catch(() => {
          if (active) setSession('anon');
        });
      return () => {
        active = false;
      };
    }, []),
  );

  if (session === 'loading') {
    return (
      <View className="flex-1 items-center justify-center bg-cream">
        <ActivityIndicator color="#0f1626" />
      </View>
    );
  }

  if (session === 'anon') return <Redirect href="/sign-in" />;

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
    </Tabs>
  );
}
