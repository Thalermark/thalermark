import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { pickActiveCompany } from '../../lib/active-company';
import { api } from '../../lib/api';
import { signOut } from '../../lib/auth-client';

// Position dashboard + AI insights (mirror of apps/web's (app)/+page.svelte).
// Replaces the Phase-6 shell placeholder. Money figures are decimal strings
// from the API — formatted for display only. Anomalies are deterministic;
// cash-flow nudges are AI (Pro+/BYOK) and degrade to empty on a 503.
type Period = 'month' | '30d' | 'ytd';
type Dashboard = { moneyIn: string; moneyOut: string; owed: string };
type Anomalies = {
  overall: { pctOver: number; recent: string; typical: string } | null;
  categories: { code: string; name: string; recent: string; typical: string; pctOver: number }[];
};
type Nudge = { text: string; tone: string };

const PERIODS: { key: Period; label: string }[] = [
  { key: 'month', label: 'This month' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'ytd', label: 'Year to date' },
];

const fmt = (s: string) =>
  Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const flowLabel = (p: Period) =>
  p === 'ytd' ? 'this year' : p === '30d' ? 'last 30 days' : 'this month';

const toneClass = (tone: string) =>
  tone === 'warning'
    ? 'border-oxblood/30 bg-oxblood/5'
    : tone === 'good'
      ? 'border-gold-deep/30 bg-gold-deep/5'
      : 'border-ink/15 bg-cream-warm';

export default function Home() {
  const router = useRouter();
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>('month');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [anomalies, setAnomalies] = useState<Anomalies>({ overall: null, categories: [] });
  const [nudges, setNudges] = useState<Nudge[]>([]);
  const [nudgesLoading, setNudgesLoading] = useState(false);
  const [pendingInvites, setPendingInvites] = useState(0);

  // Resolve the active company once on focus (Home is the first authed screen),
  // plus any pending workspace invitations for the notice below.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      api.api.companies
        .$get()
        .then(async (res) => {
          if (!active || !res.ok) return;
          const { companies } = await res.json();
          const c = await pickActiveCompany(companies);
          if (c) {
            setCompanyId(c.id);
            setCompanyName(c.name);
          }
        })
        .catch(() => {});

      // Pending invitations (bootstrap route) → a notice that deep-links to the
      // Workspace screen, where they can accept/decline.
      api.api.me.invitations
        .$get()
        .then(async (res) => {
          if (!active || !res.ok) return;
          setPendingInvites((await res.json()).invitations.length);
        })
        .catch(() => {});

      return () => {
        active = false;
      };
    }, []),
  );

  // Position + insights, re-fetched when the company or period changes.
  useEffect(() => {
    if (!companyId) return;
    let active = true;
    setLoading(true);
    api.api.companies[':id'].dashboard
      .$get({ param: { id: companyId }, query: { period, from: undefined, to: undefined } })
      .then(async (res) => {
        if (!active || !res.ok) return;
        const d = await res.json();
        setDashboard({ moneyIn: d.moneyIn, moneyOut: d.moneyOut, owed: d.owed });
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });

    api.api.companies[':id']['spending-anomalies']
      .$get({ param: { id: companyId } })
      .then(async (res) => {
        if (!active || !res.ok) return;
        const a = await res.json();
        setAnomalies({ overall: a.overall ?? null, categories: a.categories ?? [] });
      })
      .catch(() => {});

    // AI nudges: separate, best-effort. 503 (AI off) / 502 (model error) →
    // no nudges rather than a broken dashboard.
    setNudgesLoading(true);
    api.api.companies[':id']['cash-flow-nudges']
      .$get({ param: { id: companyId } })
      .then(async (res) => {
        if (!active) return;
        if (res.ok) setNudges((await res.json()).nudges ?? []);
        else setNudges([]);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setNudgesLoading(false);
      });

    return () => {
      active = false;
    };
  }, [companyId, period]);

  const showAnomalies = anomalies.overall !== null || anomalies.categories.length > 0;

  async function onSignOut() {
    await signOut();
    router.replace('/sign-in');
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <View className="flex-row items-start justify-between">
          <View className="flex-1">
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
              {companyName ?? ' '}
            </Text>
            <Text className="mt-2 font-serif text-4xl font-light text-ink">Where you stand</Text>
          </View>
          <Pressable onPress={onSignOut} className="ml-3 mt-1 px-2 py-1">
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
              Sign out
            </Text>
          </Pressable>
        </View>

        {/* Pending workspace invitations → Workspace screen to accept/decline */}
        {pendingInvites > 0 ? (
          <Pressable
            onPress={() => router.push('/more/switch-account')}
            className="mt-6 flex-row items-center justify-between rounded-sm border border-gold-deep/30 bg-gold-deep/5 px-4 py-3 active:bg-gold-deep/10"
          >
            <Text className="flex-1 text-sm text-ink">
              You have {pendingInvites} pending workspace{' '}
              {pendingInvites === 1 ? 'invitation' : 'invitations'}.
            </Text>
            <Text className="ml-3 font-mono text-xs uppercase tracking-widest text-gold-deep">
              Review →
            </Text>
          </Pressable>
        ) : null}

        {/* Period selector */}
        <View className="mt-6 flex-row flex-wrap gap-2">
          {PERIODS.map((p) => (
            <Pressable
              key={p.key}
              onPress={() => setPeriod(p.key)}
              className={`rounded-sm border px-3 py-1 ${
                period === p.key ? 'border-gold-deep' : 'border-ink/15'
              }`}
            >
              <Text
                className={`font-mono text-xs uppercase tracking-widest ${
                  period === p.key ? 'text-gold-deep' : 'text-ink/60'
                }`}
              >
                {p.label}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Position tiles */}
        {loading && !dashboard ? (
          <View className="mt-10 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        ) : dashboard ? (
          <View className="mt-8 space-y-4">
            <Tile label="Money in" value={fmt(dashboard.moneyIn)} sub={flowLabel(period)} />
            <Tile label="Money out" value={fmt(dashboard.moneyOut)} sub={flowLabel(period)} />
            <Tile label="Owed to you" value={fmt(dashboard.owed)} sub="outstanding now" />
          </View>
        ) : (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load your position.</Text>
        )}

        {/* Unusual spending (deterministic) */}
        {showAnomalies ? (
          <View className="mt-8">
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
              Unusual spending
            </Text>
            <View className="mt-3 space-y-3">
              {anomalies.overall ? (
                <View className="rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
                  <Text className="text-sm text-ink/80">
                    Spending is {anomalies.overall.pctOver}% above your typical month —{' '}
                    {fmt(anomalies.overall.recent)} in the last 30 days vs about{' '}
                    {fmt(anomalies.overall.typical)}.
                  </Text>
                </View>
              ) : null}
              {anomalies.categories.map((cat) => (
                <View
                  key={cat.code}
                  className="rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3"
                >
                  <Text className="text-sm text-ink/80">
                    {cat.name}: {fmt(cat.recent)} vs about {fmt(cat.typical)} usual ({cat.pctOver}%
                    up).
                  </Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {/* What to watch (AI) */}
        {nudgesLoading ? (
          <View className="mt-8 flex-row items-center gap-2">
            <ActivityIndicator color="#9a7b4f" size="small" />
            <Text className="text-sm text-ink/50">Reading your cash flow…</Text>
          </View>
        ) : nudges.length > 0 ? (
          <View className="mt-8">
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
              What to watch
            </Text>
            <View className="mt-3 space-y-3">
              {nudges.map((n) => (
                <View key={n.text} className={`rounded-sm border px-4 py-3 ${toneClass(n.tone)}`}>
                  <Text className="text-sm text-ink/80">{n.text}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <View className="rounded-sm border border-ink/10 bg-cream-warm p-6">
      <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">{label}</Text>
      <Text className="mt-2 font-serif text-3xl font-light tabular-nums text-ink">{value}</Text>
      <Text className="mt-1 text-xs text-ink/40">{sub}</Text>
    </View>
  );
}
