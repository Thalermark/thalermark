import { Ionicons } from '@expo/vector-icons';
import type { Role } from '@thalermark/validation';
import { Redirect, Tabs, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, Text, View } from 'react-native';
import { LegalConsentGate } from '../../components/LegalConsentGate';
import { resolveActiveAccount } from '../../lib/active-account';
import { pickActiveCompany } from '../../lib/active-company';
import { api } from '../../lib/api';
import { authClient } from '../../lib/auth-client';
import { RoleProvider } from '../../lib/role';
import { beginSession, endSession } from '../../lib/session-telemetry';
import { flushTelemetry, setTelemetryEnabled } from '../../lib/telemetry';

// 'loading' until the session + active-account resolution settles, then:
//   'anon'    → no session, go sign in
//   'select'  → authed with several memberships, none chosen → pick one
//   'onboard' → active company has no business type yet → run the welcome wizard
//   'consent' → deployment requires Terms/Privacy and this user hasn't accepted
//   'ready'   → authed with an active account resolved → render the app
type Gate = 'loading' | 'anon' | 'select' | 'ready' | 'error' | 'onboard' | 'consent';

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
  // The active membership's role, fed to RoleProvider for UX capability gating.
  const [role, setRole] = useState<Role | undefined>(undefined);
  // Terms/Privacy URLs for the consent gate, set when gate === 'consent'.
  const [legal, setLegal] = useState<{ termsUrl: string; privacyUrl: string } | null>(null);

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
        if (account.status !== 'ok') {
          setRole(undefined);
          setGate(account.status === 'error' ? 'error' : 'select');
          return;
        }
        setRole(account.role);
        // First-run onboarding: a fresh signup's company has no business type yet
        // — the trigger for web's /welcome gate (apps/web's (app)/+layout.server.ts).
        // Send the user through the welcome wizard before the app proper, so the
        // entity type is captured. A failed companies fetch never traps them — we
        // fall through to the app.
        const compRes = await api.api.companies.$get();
        if (!active) return;
        if (compRes.ok) {
          const { companies } = await compRes.json();
          const picked = await pickActiveCompany(companies);
          const row = companies.find((c) => c.id === picked?.id);
          if (row && row.businessType === null) {
            setGate('onboard');
            return;
          }
        }
        // Legal-consent gate (spikes/SIGN-UP-ACK-TOS.md), after onboarding —
        // mirrors web's (app) layout. When the deployment requires Terms/Privacy
        // and this person hasn't accepted the current version, block on the
        // consent screen before the app. required:false (default self-host) →
        // falls straight through. A failed fetch never traps them.
        const legalRes = await api.api.legal.$get();
        if (!active) return;
        if (legalRes.ok) {
          const l = await legalRes.json();
          if (l.required && !l.accepted) {
            setLegal({
              termsUrl: l.termsUrl ?? '/legal/terms',
              privacyUrl: l.privacyUrl ?? '/legal/privacy',
            });
            setGate('consent');
            return;
          }
        }
        // Sync the client telemetry emitter's gate with the account's opt-in
        // (every member — report views come from any role). Best-effort.
        api.api.account.telemetry
          .$get()
          .then(async (r) => {
            if (!active || !r.ok) return;
            const en = (await r.json()).enabled;
            setTelemetryEnabled(en);
            if (en) beginSession();
          })
          .catch(() => {});
        setGate('ready');
      })
      .catch(() => {
        if (active) setGate('anon');
      });
    return () => {
      active = false;
    };
  }, []);

  useFocusEffect(runGate);

  // Session boundaries + flush on foreground change — the mobile counterpart of
  // web's visibility-hidden handling. Background/inactive closes the session
  // (session_end, which flushes) and flushes any remaining buffer; returning to
  // active opens a new one. beginSession/endSession no-op when opted out.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') {
        endSession();
        void flushTelemetry();
      } else if (state === 'active') {
        beginSession();
      }
    });
    return () => sub.remove();
  }, []);

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
  if (gate === 'onboard') return <Redirect href="/welcome" />;
  if (gate === 'consent' && legal) {
    return (
      <LegalConsentGate
        termsUrl={legal.termsUrl}
        privacyUrl={legal.privacyUrl}
        onAccepted={() => {
          setGate('loading');
          runGate();
        }}
      />
    );
  }

  return (
    <RoleProvider role={role}>
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
          name="contacts"
          options={{
            title: 'Contacts',
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
        {/* Global search (TMC-198) — reached from the Home header and the More
          hub, not the tab bar. Deliberately not a sixth tab: search is
          something you reach for, not somewhere you live. */}
        <Tabs.Screen name="search" options={{ href: null }} />
        <Tabs.Screen name="estimates" options={{ href: null }} />
        <Tabs.Screen name="bills" options={{ href: null }} />
        <Tabs.Screen name="owner-money" options={{ href: null }} />
        {/* Big purchases — reached from the Expenses-new branch, not the tab bar. */}
        <Tabs.Screen name="purchases" options={{ href: null }} />
        {/* The Ledger is reached from the More hub's Accounting section, not the
          tab bar. */}
        <Tabs.Screen name="ledger" options={{ href: null }} />
        <Tabs.Screen name="select-company" options={{ href: null }} />
        {/* Jobs and mileage are reached from the More hub's Work section.
          EVERY route folder under (app) becomes a tab unless it is named here —
          so these two shipped as a sixth and seventh tab, labelled with their
          folder names in lower case and drawn with a placeholder glyph, which is
          how the five-tab consolidation quietly came undone. Adding a route
          folder here is adding a tab; that is the thing to remember. */}
        <Tabs.Screen name="jobs" options={{ href: null }} />
        <Tabs.Screen name="mileage" options={{ href: null }} />
      </Tabs>
    </RoleProvider>
  );
}
