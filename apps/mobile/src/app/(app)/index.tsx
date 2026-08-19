import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MetricStrip } from '../../components/MetricStrip';
import { pickActiveCompany } from '../../lib/active-company';
import { api } from '../../lib/api';
import { signOut } from '../../lib/auth-client';
import { useMay } from '../../lib/role';
import { trackEvent } from '../../lib/telemetry';

// Position dashboard + AI insights (mirror of apps/web's (app)/+page.svelte).
// Replaces the Phase-6 shell placeholder. Money figures are decimal strings
// from the API — formatted for display only. Anomalies are deterministic;
// cash-flow nudges are AI (Pro+/BYOK) and degrade to empty on a 503.
type Period = 'month' | '30d' | 'ytd';
type Dashboard = { moneyIn: string; moneyOut: string; owed: string; owing: string };
type Anomalies = {
  overall: { pctOver: number; recent: string; typical: string } | null;
  categories: { code: string; name: string; recent: string; typical: string; pctOver: number }[];
};
type Nudge = { text: string; tone: string };
// Point-in-time entity counts for the "Right now" tiles (mirror of web). Counts
// only — the money tiles above own the dollars, so no duplicate of "Owed to you".
type Counts = {
  overdue: number;
  awaiting: number;
  drafts: number;
  openEstimates: number;
  acceptedEstimates: number;
  undelivered: number;
};

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
  const [counts, setCounts] = useState<Counts | null>(null);
  const [loading, setLoading] = useState(true);
  const [anomalies, setAnomalies] = useState<Anomalies>({ overall: null, categories: [] });
  const [nudges, setNudges] = useState<Nudge[]>([]);
  const [nudgesLoading, setNudgesLoading] = useState(false);
  const [pendingInvites, setPendingInvites] = useState(0);
  // First-run telemetry consent (TELEMETRY.md). Account-wide, so only the
  // settings:manage roles are asked; others never see it. `consentNeeded` flips
  // off the moment they answer (locally) or once the account has decided.
  const canManageSettings = useMay('settings:manage');
  const [consentNeeded, setConsentNeeded] = useState(false);
  const [consentBusy, setConsentBusy] = useState(false);

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

      // First-run telemetry consent. Gated settings:manage on the API, so only
      // ask roles that can actually decide; show the prompt until the account
      // has answered and the deployment hasn't disabled telemetry.
      if (canManageSettings) {
        api.api.account.telemetry
          .$get()
          .then(async (res) => {
            if (!active || !res.ok) return;
            const t = await res.json();
            setConsentNeeded(!t.decided && !t.disabled);
          })
          .catch(() => {});
      }

      return () => {
        active = false;
      };
    }, [canManageSettings]),
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
        setDashboard({ moneyIn: d.moneyIn, moneyOut: d.moneyOut, owed: d.owed, owing: d.owing });
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

  // Point-in-time counts (NOT period-bound → keyed on companyId only, so the
  // period toggle doesn't refetch them). Company-scoped to match the dashboard.
  // Best-effort: a non-OK degrades to zeros rather than failing the screen.
  useEffect(() => {
    if (!companyId) return;
    let active = true;
    Promise.all([
      api.api.invoices.summary.$get({ query: { companyId } }),
      api.api.estimates.summary.$get({ query: { companyId } }),
    ])
      .then(async ([invRes, estRes]) => {
        if (!active) return;
        const inv = invRes.ok ? await invRes.json() : null;
        const est = estRes.ok ? await estRes.json() : null;
        setCounts({
          overdue: inv?.overdue.count ?? 0,
          awaiting: inv?.awaiting.count ?? 0,
          drafts: inv?.draft.count ?? 0,
          openEstimates: est?.open.count ?? 0,
          // The customer said yes and nothing has been billed for it (TMC-230).
          // Accepting is the highest-value event in the product, and the
          // estimate used to leave the "open" tile on acceptance, so the one
          // surface tracking it stopped showing it exactly when it became
          // actionable.
          acceptedEstimates: est?.acceptedUnbilled.count ?? 0,
          // Invoices whose email did not arrive (TMC-226). Before this the only
          // trace of a bounce was a server log line, so an invoice that reached
          // nobody looked exactly like one being ignored.
          undelivered: inv?.undelivered.count ?? 0,
        });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [companyId]);

  const showAnomalies = anomalies.overall !== null || anomalies.categories.length > 0;

  // ai_insight_viewed (TELEMETRY.md client ingest) — fire per rendered insight
  // surface: the deterministic "Unusual spending" section (anomaly) and the AI
  // "What to watch" nudges (cashflow). trackEvent no-ops when opted out;
  // re-fires when the section re-renders on a company/period change, mirroring
  // web's dashboard and report_viewed's re-fire-on-focus behaviour.
  useEffect(() => {
    if (showAnomalies) trackEvent({ name: 'ai_insight_viewed', insight_type: 'anomaly' });
  }, [showAnomalies]);

  useEffect(() => {
    if (nudges.length > 0) trackEvent({ name: 'ai_insight_viewed', insight_type: 'cashflow' });
  }, [nudges]);

  async function onSignOut() {
    await signOut();
    router.replace('/sign-in');
  }

  // Answer the first-run consent prompt. Either choice stamps decided
  // server-side; dismiss locally on success so the card disappears at once.
  async function onAnswerConsent(enabled: boolean) {
    setConsentBusy(true);
    try {
      const res = await api.api.account.telemetry.$patch({ json: { enabled } });
      if (res.ok) setConsentNeeded(false);
    } catch {
      // Leave the prompt up; they can retry or use Settings → Privacy.
    } finally {
      setConsentBusy(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <View className="flex-row items-start justify-between">
          <View className="flex-1">
            <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
              {companyName ?? ' '}
            </Text>
            <Text className="mt-2 font-serif text-4xl font-light text-ink">Where you stand</Text>
          </View>
          <Pressable onPress={onSignOut} className="ml-3 mt-1 px-2 py-1">
            <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
              Sign out
            </Text>
          </Pressable>
        </View>

        {/* Search (TMC-198). A pressable bar rather than a live input: tapping
          it opens the search screen with its own autofocused field, so this
          costs Home nothing but a row and there is no second debounce to keep
          in sync. */}
        <Pressable
          onPress={() => router.push('/search')}
          accessibilityRole="search"
          accessibilityLabel="Search"
          className="mt-6 flex-row items-center gap-2 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2.5 active:bg-gold-deep/10"
        >
          <Ionicons name="search-outline" size={16} color="#0f162680" />
          <Text className="text-ink-subtle">Search invoices, contacts, expenses…</Text>
        </Pressable>

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

        {/* First-run telemetry consent */}
        {consentNeeded ? (
          <View className="mt-6 rounded-sm border border-gold-deep/30 bg-gold-deep/5 px-4 py-4">
            <Text className="font-serif text-base text-ink">Help us build a better product</Text>
            <Text className="mt-1 text-sm text-ink-muted">
              We'd like to collect anonymous usage data — which features you use and where errors
              occur. We never collect personal or financial information. You can change this any
              time in More → Privacy.
            </Text>
            <View className="mt-4 flex-row gap-3">
              <Pressable
                onPress={() => onAnswerConsent(true)}
                disabled={consentBusy}
                className="rounded-sm bg-ink px-4 py-2 active:bg-gold-deep disabled:opacity-50"
              >
                <Text className="text-sm font-medium text-cream">Yes, help</Text>
              </Pressable>
              <Pressable
                onPress={() => onAnswerConsent(false)}
                disabled={consentBusy}
                className="rounded-sm border border-ink/20 px-4 py-2 active:bg-cream disabled:opacity-50"
              >
                <Text className="text-sm font-medium text-ink">No thanks</Text>
              </Pressable>
            </View>
          </View>
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
                  period === p.key ? 'text-gold-deep' : 'text-ink-subtle'
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
          <View className="mt-8 gap-4">
            <Tile label="Money in" value={fmt(dashboard.moneyIn)} sub={flowLabel(period)} />
            <Tile label="Money out" value={fmt(dashboard.moneyOut)} sub={flowLabel(period)} />
            <Tile label="Owed to you" value={fmt(dashboard.owed)} sub="outstanding now" />
            <Tile label="Owed by you" value={fmt(dashboard.owing)} sub="bills outstanding" />
          </View>
        ) : (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load your position.</Text>
        )}

        {/* Right now — point-in-time counts (NOT period-bound). Counts only; the
            money tiles above own the dollars. Each tile deep-links to its
            filtered list. */}
        {counts ? (
          <View className="mt-8">
            <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
              Right now
            </Text>
            <View className="mt-3">
              <MetricStrip
                tiles={[
                  {
                    label: 'Overdue',
                    value: counts.overdue,
                    onPress: () => router.push('/invoices?bucket=overdue'),
                    alert: counts.overdue > 0,
                  },
                  {
                    label: 'Awaiting',
                    value: counts.awaiting,
                    onPress: () => router.push('/invoices?bucket=awaiting'),
                  },
                  {
                    label: 'Drafts',
                    value: counts.drafts,
                    onPress: () => router.push('/invoices?status=draft'),
                  },
                  {
                    label: 'Open estimates',
                    value: counts.openEstimates,
                    onPress: () => router.push('/estimates?status=sent'),
                  },
                  // Flagged like an overdue invoice, because it is the same
                  // kind of fact: the customer has acted and the business has
                  // not (TMC-230).
                  {
                    label: 'Accepted',
                    value: counts.acceptedEstimates,
                    onPress: () => router.push('/estimates?status=accepted'),
                    alert: counts.acceptedEstimates > 0,
                  },
                  // Only shown when something is wrong. A permanent
                  // "0 undelivered" would be one more number to ignore; a tile
                  // that appears only when an email did not arrive is the whole
                  // point (TMC-226).
                  ...(counts.undelivered > 0
                    ? [
                        {
                          label: 'Not delivered',
                          value: counts.undelivered,
                          onPress: () => router.push('/invoices?bucket=undelivered'),
                          alert: true,
                        },
                      ]
                    : []),
                ]}
              />
            </View>
          </View>
        ) : null}

        {/* Unusual spending (deterministic) */}
        {showAnomalies ? (
          <View className="mt-8">
            <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
              Unusual spending
            </Text>
            <View className="mt-3 gap-3">
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
            <Text className="text-sm text-ink-subtle">Reading your cash flow…</Text>
          </View>
        ) : nudges.length > 0 ? (
          <View className="mt-8">
            <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
              What to watch
            </Text>
            {/*
              The tiles above follow the period toggle; the nudge signals are
              always month-to-date, so on "this year" a tile and the nudge under
              it quote different figures and read as a contradiction. Same label
              as web (TMC-229).
            */}
            <Text className="mt-1 text-xs text-ink-subtle">this month so far</Text>
            <View className="mt-3 gap-3">
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
      <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">{label}</Text>
      <Text className="mt-2 font-serif text-3xl font-light tabular-nums text-ink">{value}</Text>
      <Text className="mt-1 text-xs text-ink-subtle">{sub}</Text>
    </View>
  );
}
