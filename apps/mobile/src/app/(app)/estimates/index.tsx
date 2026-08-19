import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ContactFilterField, type SelectedContact } from '../../../components/ContactFilterField';
import { DateField } from '../../../components/DateField';
import { FilterChips } from '../../../components/FilterChips';
import { MetricStrip } from '../../../components/MetricStrip';
import { api } from '../../../lib/api';
import { useMay } from '../../../lib/role';
import { pageQuery, usePaginatedList } from '../../../lib/use-paginated-list';

const fmt = (s: string) =>
  Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// Status summary powering the metric strip (mirror of web). 'open' = sent
// (awaiting a reply); distinct statuses, so buckets don't overlap.
type EstimateSummary = {
  draft: { count: number };
  open: { count: number; total: string };
  accepted: { count: number; total: string };
};

// Mirror of apps/web's /estimates list. customerName is LEFT JOINed by the API
// (#195); keyset infinite scroll via usePaginatedList. Filters mirror the web
// filter bar: search (q), status, date range (issueDate), single contact.
type EstimateRow = {
  id: string;
  number: string;
  customerName: string | null;
  status: string;
  issueDate: string;
  currency: string;
  total: string;
};

const STATUS_OPTIONS = [
  { label: 'All', value: '' },
  { label: 'Draft', value: 'draft' },
  { label: 'Sent', value: 'sent' },
  { label: 'Accepted', value: 'accepted' },
  { label: 'Declined', value: 'declined' },
  { label: 'Expired', value: 'expired' },
];

export default function EstimatesList() {
  const router = useRouter();
  const canCreate = useMay('sales:write');
  const params = useLocalSearchParams<{ status?: string }>();

  const [q, setQ] = useState('');
  const [appliedQ, setAppliedQ] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [contact, setContact] = useState<SelectedContact | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [summary, setSummary] = useState<EstimateSummary | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setAppliedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Seed the status filter from a deep-link param (dashboard Open-estimates tile).
  useEffect(() => {
    if (params.status) setStatus(params.status);
  }, [params.status]);

  // Point-in-time status summary for the strip; refreshed on focus. Best-effort.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      api.api.estimates.summary
        .$get({ query: {} })
        .then(async (res) => {
          if (active && res.ok) setSummary(await res.json());
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }, []),
  );

  const advancedActive = Boolean(from || to || contact);
  const anyFilter = Boolean(appliedQ || status || advancedActive);

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const query: Record<string, string> = pageQuery(cursor);
      if (appliedQ) query.q = appliedQ;
      if (status) query.status = status;
      if (from) query.from = from;
      if (to) query.to = to;
      if (contact) query.contactId = contact.id;
      const res = await api.api.estimates.$get({ query });
      if (!res.ok) return null;
      const { estimates, nextCursor } = await res.json();
      return {
        rows: estimates.map(
          (e): EstimateRow => ({
            id: e.id,
            number: e.number,
            customerName: e.customerName ?? null,
            status: e.status,
            issueDate: e.issueDate,
            currency: e.currency,
            total: e.total,
          }),
        ),
        nextCursor,
      };
    },
    [appliedQ, status, from, to, contact],
  );

  const { list, loadingMore, loadMore } = usePaginatedList(fetchPage);

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <View className="flex-row items-end justify-between px-6 pt-6">
        <View>
          <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
            Estimates
          </Text>
          <Text className="mt-2 font-serif text-3xl font-light text-ink">All estimates</Text>
        </View>
        {canCreate ? (
          <Pressable
            onPress={() => router.push('/estimates/new')}
            className="rounded-sm bg-ink px-4 py-2 active:bg-gold-deep"
          >
            <Text className="text-sm font-medium text-cream">+ New</Text>
          </Pressable>
        ) : null}
      </View>

      {summary ? (
        <View className="mt-4 px-6">
          <MetricStrip
            tiles={[
              {
                label: 'Draft',
                value: summary.draft.count,
                onPress: () => setStatus('draft'),
                active: status === 'draft',
              },
              {
                label: 'Open',
                value: summary.open.count,
                sub: fmt(summary.open.total),
                onPress: () => setStatus('sent'),
                active: status === 'sent',
              },
              {
                label: 'Accepted',
                value: summary.accepted.count,
                sub: fmt(summary.accepted.total),
                onPress: () => setStatus('accepted'),
                active: status === 'accepted',
              },
            ]}
          />
        </View>
      ) : null}

      <View className="mt-4 flex-row items-center gap-2 px-6">
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search number or contact"
          returnKeyType="search"
          className="flex-1 rounded-sm border border-field bg-cream-warm px-3 py-2.5 text-ink"
        />
        <Pressable
          onPress={() => setShowAdvanced((v) => !v)}
          className={`rounded-sm border px-3 py-2.5 ${
            advancedActive ? 'border-ink bg-ink' : 'border-ink/20 bg-cream-warm'
          }`}
        >
          <Text
            className={`font-mono text-xs uppercase tracking-widest ${
              advancedActive ? 'text-cream' : 'text-ink-subtle'
            }`}
          >
            Filters
          </Text>
        </Pressable>
      </View>

      <View className="mt-3">
        <FilterChips options={STATUS_OPTIONS} value={status} onChange={setStatus} />
      </View>

      {showAdvanced ? (
        <View className="mt-3 gap-3 px-6">
          <View className="flex-row gap-3">
            <View className="flex-1">
              <DateField label="Issued from" value={from} onChange={setFrom} optional />
            </View>
            <View className="flex-1">
              <DateField label="To" value={to} onChange={setTo} optional />
            </View>
          </View>
          <View>
            <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
              Contact
            </Text>
            <View className="mt-1">
              <ContactFilterField selected={contact} onChange={setContact} />
            </View>
          </View>
        </View>
      ) : null}

      {list.state === 'loading' ? (
        <View className="mt-12 items-center">
          <ActivityIndicator className="text-ink" />
        </View>
      ) : list.state === 'error' ? (
        <Text className="mt-8 px-6 text-sm text-oxblood">Couldn't load estimates.</Text>
      ) : list.rows.length === 0 ? (
        <Text className="mt-8 px-6 text-ink-muted">
          {anyFilter ? 'No estimates match these filters.' : 'No estimates yet.'}
        </Text>
      ) : (
        <FlatList
          data={list.rows}
          keyExtractor={(e) => e.id}
          className="mt-6"
          contentContainerClassName="px-6 pb-6"
          keyboardShouldPersistTaps="handled"
          ItemSeparatorComponent={() => <View className="h-px bg-ink/10" />}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingMore ? (
              <View className="py-4">
                <ActivityIndicator className="text-ink" />
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push(`/estimates/${item.id}`)}
              className="bg-cream-warm px-5 py-4 active:bg-cream"
            >
              <View className="flex-row items-center justify-between">
                <Text className="font-serif text-lg text-ink">{item.number}</Text>
                <Text className="font-mono tabular-nums text-ink">
                  {item.currency} {item.total}
                </Text>
              </View>
              <View className="mt-1 flex-row items-center justify-between">
                <Text className="text-sm text-ink-muted">{item.customerName ?? '—'}</Text>
                <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                  {item.status} · {item.issueDate}
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}
