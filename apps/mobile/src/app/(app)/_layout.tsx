import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { resolveActiveAccount } from '../../lib/active-account';
import { authClient } from '../../lib/auth-client';

// 'loading' until the session + active-account resolution settles, then:
//   'anon'   → no session, go sign in
//   'select' → authed with several memberships, none chosen → pick one
//   'ready'  → authed with an active account resolved → render the app
type Gate = 'loading' | 'anon' | 'select' | 'ready' | 'error';

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

  // Extracted so the error-state Retry button can re-run it. Mirrors web's
  // hooks.server.ts: a 5xx/unreachable /api/me is a server fault ('error'),
  // distinct from "no session" (anon) and "no memberships" (select).
  const runGate = useCallback(() => {
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
        setGate(
          account.status === 'ok' ? 'ready' : account.status === 'error' ? 'error' : 'select',
        );
      })
      .catch(() => {
        if (active) setGate('anon');
      });
    return () => {
      active = false;
    };
  }, []);

  useFocusEffect(runGate);

  if (gate === 'loading') {
    return (
      <View className="flex-1 items-center justify-center bg-cream">
        <ActivityIndicator color="#0f1626" />
      </View>
    );
  }

  if (gate === 'error') {
    return (
      <View className="flex-1 items-center justify-center bg-cream px-6">
        <Text className="text-center text-sm text-oxblood">
          Something went wrong reaching the server.
        </Text>
        <Pressable
          onPress={() => {
            setGate('loading');
            runGate();
          }}
          className="mt-5 rounded-sm bg-ink px-4 py-2.5 active:bg-gold-deep"
        >
          <Text className="text-sm font-medium text-cream">Try again</Text>
        </Pressable>
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
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'home' : 'home-outline'} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="invoices"
        options={{
          title: 'Invoices',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'receipt' : 'receipt-outline'} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="expenses"
        options={{
          title: 'Expenses',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'wallet' : 'wallet-outline'} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="customers"
        options={{
          title: 'Customers',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'people' : 'people-outline'} size={size} color={color} />
          ),
        }}
      />
      {/* The "More" hub holds everything that doesn't earn a top-level tab:
          Estimates + Recurring (Sales), account admin, the items catalog +
          reports, the activity feed, and business/payments/email settings.
          M11f consolidated the bar down to these five tabs. */}
      <Tabs.Screen
        name="more"
        options={{
          title: 'More',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons
              name={focused ? 'ellipsis-horizontal' : 'ellipsis-horizontal-outline'}
              size={size}
              color={color}
            />
          ),
        }}
      />
      {/* Routable but hidden from the tab bar. Estimates lost its tab in the
          M11f consolidation — it's reached from the More hub's Sales section;
          select-company is reached via redirect only. */}
      <Tabs.Screen name="estimates" options={{ href: null }} />
      <Tabs.Screen name="select-company" options={{ href: null }} />
    </Tabs>
  );
}
