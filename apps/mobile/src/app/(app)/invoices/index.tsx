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

// Status summary powering the metric strip (mirror of web). awaiting/overdue
// partition the sent-but-unpaid pool by due date.
type InvoiceSummary = {
  draft: { count: number };
  awaiting: { count: number; total: string };
  overdue: { count: number; total: string };
  // Pulled back to be corrected and not yet resent (TMC-227). Optional: a
  // mobile binary in the stores may be talking to an older API, and a missing
  // count must read as "none" rather than crash the strip.
  revising?: { count: number };
};
// Derived date-partition buckets (not stored statuses); alternatives to a
// plain status filter, so picking one clears status and vice-versa.
type Bucket = '' | 'overdue' | 'awaiting' | 'revising';

// Mirror of apps/web's /invoices list. customerName is LEFT JOINed by the API
// now (#195), so the list no longer fetches every contact to resolve names —
// that doesn't survive pagination. Keyset infinite scroll via usePaginatedList.
//
// Filters mirror the web filter bar: search (q, number OR contact name),
// status, date range (issueDate), and a single contact. usePaginatedList
// reloads page 1 whenever fetchPage's identity changes, so flipping any filter
// re-runs the query from the top.
type InvoiceRow = {
  id: string;
  number: string;
  customerName: string | null;
  status: string;
  // Carried so the row can show "being revised" — derived, not a sixth status.
  sentAt: string | null;
  dueDate: string;
  currency: string;
  total: string;
};

const STATUS_OPTIONS = [
  { label: 'All', value: '' },
  { label: 'Draft', value: 'draft' },
  { label: 'Sent', value: 'sent' },
  { label: 'Paid', value: 'paid' },
  { label: 'Voided', value: 'voided' },
];

export default function InvoicesList() {
  const router = useRouter();
  const canCreate = useMay('sales:write');
  const params = useLocalSearchParams<{ status?: string; bucket?: string }>();

  const [q, setQ] = useState('');
  const [appliedQ, setAppliedQ] = useState('');
  const [status, setStatus] = useState('');
  const [bucket, setBucket] = useState<Bucket>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [contact, setContact] = useState<SelectedContact | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [summary, setSummary] = useState<InvoiceSummary | null>(null);

  // Debounce the search box so each keystroke doesn't refetch.
  useEffect(() => {
    const t = setTimeout(() => setAppliedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Seed the filter from deep-link params (dashboard tiles → this list). Status
  // and bucket are mutually exclusive, so applying one clears the other.
  useEffect(() => {
    if (params.bucket === 'overdue' || params.bucket === 'awaiting') {
      setBucket(params.bucket);
      setStatus('');
    } else if (params.status) {
      setStatus(params.status);
      setBucket('');
    }
  }, [params.status, params.bucket]);

  // Point-in-time status summary for the strip; refreshed on focus so counts
  // reflect edits made elsewhere. Best-effort.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      api.api.invoices.summary
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
  const anyFilter = Boolean(appliedQ || status || bucket || advancedActive);

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const query: Record<string, string> = pageQuery(cursor);
      if (appliedQ) query.q = appliedQ;
      if (status) query.status = status;
      if (bucket) query[bucket] = 'true';
      if (from) query.from = from;
      if (to) query.to = to;
      if (contact) query.contactId = contact.id;
      const res = await api.api.invoices.$get({ query });
      if (!res.ok) return null;
      const { invoices, nextCursor } = await res.json();
      return {
        rows: invoices.map(
          (i): InvoiceRow => ({
            id: i.id,
            number: i.number,
            customerName: i.customerName ?? null,
            status: i.status,
            sentAt: i.sentAt ?? null,
            dueDate: i.dueDate,
            currency: i.currency,
            total: i.total,
          }),
        ),
        nextCursor,
      };
    },
    [appliedQ, status, bucket, from, to, contact],
  );

  const { list, loadingMore, loadMore } = usePaginatedList(fetchPage);

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <View className="flex-row items-end justify-between px-6 pt-6">
        <View>
          <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
            Invoices
          </Text>
          <Text className="mt-2 font-serif text-3xl font-light text-ink">All invoices</Text>
        </View>
        {canCreate ? (
          <Pressable
            onPress={() => router.push('/invoices/new')}
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
                onPress: () => {
                  setStatus('draft');
                  setBucket('');
                },
                active: status === 'draft',
              },
              {
                label: 'Awaiting',
                value: summary.awaiting.count,
                sub: fmt(summary.awaiting.total),
                onPress: () => {
                  setBucket('awaiting');
                  setStatus('');
                },
                active: bucket === 'awaiting',
              },
              {
                label: 'Overdue',
                value: summary.overdue.count,
                sub: fmt(summary.overdue.total),
                onPress: () => {
                  setBucket('overdue');
                  setStatus('');
                },
                active: bucket === 'overdue',
                alert: summary.overdue.count > 0,
              },
              // Only when there is one, like the web strip and the dashboard's
              // "Not delivered" tile (TMC-227) — a permanent "0 being fixed" is
              // one more number to ignore. It appears at the moment it matters:
              // a correction started and never resent leaves the customer's
              // link saying "being revised" indefinitely.
              ...((summary.revising?.count ?? 0) > 0
                ? [
                    {
                      label: 'Being fixed',
                      value: summary.revising?.count ?? 0,
                      sub: 'not resent yet',
                      onPress: () => {
                        setBucket('revising');
                        setStatus('');
                      },
                      active: bucket === 'revising',
                      alert: true,
                    },
                  ]
                : []),
            ]}
          />
        </View>
      ) : null}

      <Pressable
        onPress={() => router.push('/invoices/recurring')}
        className="mt-4 flex-row items-center justify-between px-6 py-1"
      >
        <Text className="text-sm font-medium text-gold-deep">Repeating invoices</Text>
        <Text className="text-gold-deep">→</Text>
      </Pressable>

      <View className="mt-4 flex-row items-center gap-2 px-6">
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search number or contact"
          returnKeyType="search"
          className="flex-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2.5 text-ink"
        />
        <Pressable
          onPress={() => setShowAdvanced((v) => !v)}
          className={`rounded-sm border px-3 py-2.5 ${
            advancedActive ? 'border-ink bg-ink' : 'border-ink/20 bg-cream-warm'
          }`}
        >
          <Text
            className={`font-mono text-xs uppercase tracking-widest ${
              advancedActive ? 'text-cream' : 'text-ink/60'
            }`}
          >
            Filters
          </Text>
        </Pressable>
      </View>

      <View className="mt-3">
        <FilterChips
          options={STATUS_OPTIONS}
          value={status}
          onChange={(v) => {
            setStatus(v);
            setBucket('');
          }}
        />
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
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">Contact</Text>
            <View className="mt-1">
              <ContactFilterField selected={contact} onChange={setContact} />
            </View>
          </View>
        </View>
      ) : null}

      {list.state === 'loading' ? (
        <View className="mt-12 items-center">
          <ActivityIndicator color="#0f1626" />
        </View>
      ) : list.state === 'error' ? (
        <Text className="mt-8 px-6 text-sm text-oxblood">Couldn't load invoices.</Text>
      ) : list.rows.length === 0 ? (
        <Text className="mt-8 px-6 text-ink/70">
          {anyFilter ? 'No invoices match these filters.' : 'No invoices yet.'}
        </Text>
      ) : (
        <FlatList
          data={list.rows}
          keyExtractor={(i) => i.id}
          className="mt-6"
          contentContainerClassName="px-6 pb-6"
          keyboardShouldPersistTaps="handled"
          ItemSeparatorComponent={() => <View className="h-px bg-ink/10" />}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingMore ? (
              <View className="py-4">
                <ActivityIndicator color="#0f1626" />
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push(`/invoices/${item.id}`)}
              className="bg-cream-warm px-5 py-4 active:bg-cream"
            >
              <View className="flex-row items-center justify-between">
                <Text className="font-serif text-lg text-ink">{item.number}</Text>
                <Text className="font-mono tabular-nums text-ink">
                  {item.currency} {item.total}
                </Text>
              </View>
              <View className="mt-1 flex-row items-center justify-between">
                <Text className="text-sm text-ink/70">{item.customerName ?? '—'}</Text>
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                  {item.status === 'draft' && item.sentAt !== null ? 'being revised' : item.status}{' '}
                  · {item.dueDate}
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}
