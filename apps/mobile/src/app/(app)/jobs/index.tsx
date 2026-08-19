import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MetricStrip } from '../../../components/MetricStrip';
import { api } from '../../../lib/api';
import { useMay } from '../../../lib/role';
import { pageQuery, usePaginatedList } from '../../../lib/use-paginated-list';

// Mirror of apps/web's /jobs list. Open jobs by default — a closed job is filed
// away, and the point of closing one is that it stops cluttering the pickers.
type JobRow = {
  id: string;
  name: string;
  status: string;
  contactName: string | null;
  startedOn: string | null;
  endedOn: string | null;
  readyToBill: string;
  unratedMinutes: number;
};

type JobSummary = {
  open: number;
  closed: number;
  readyToBill: string;
  readyToBillOnClosed: string;
  jobsWithMoneyWaiting: number;
  unratedMinutes: number;
  unratedHours: string;
};

type StatusFilter = 'open' | 'closed' | 'all';

const fmt = (s: string) =>
  Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

function dateRange(startedOn: string | null, endedOn: string | null): string {
  if (startedOn && endedOn) return `${startedOn} → ${endedOn}`;
  if (startedOn) return `Started ${startedOn}`;
  if (endedOn) return `Ended ${endedOn}`;
  return '';
}

export default function JobsList() {
  const router = useRouter();
  const canCreate = useMay('sales:write');

  const [status, setStatus] = useState<StatusFilter>('open');
  const [q, setQ] = useState('');
  const [appliedQ, setAppliedQ] = useState('');
  const [summary, setSummary] = useState<JobSummary | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setAppliedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Refreshed on focus so billing a job on another screen is reflected when you
  // come back. Best-effort: a failure hides the strip rather than the list.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      api.api.jobs.summary
        .$get({ query: {} })
        .then(async (res) => {
          if (active && res.ok) setSummary((await res.json()) as JobSummary);
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }, []),
  );

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const query: Record<string, string> = pageQuery(cursor);
      if (status !== 'all') query.status = status;
      if (appliedQ) query.q = appliedQ;
      const res = await api.api.jobs.$get({ query });
      if (!res.ok) return null;
      const { jobs, nextCursor } = await res.json();
      return {
        rows: jobs.map(
          (j): JobRow => ({
            id: j.id,
            name: j.name,
            status: j.status,
            contactName: j.contactName,
            startedOn: j.startedOn,
            endedOn: j.endedOn,
            readyToBill: j.readyToBill,
            unratedMinutes: j.unratedMinutes,
          }),
        ),
        nextCursor,
      };
    },
    [status, appliedQ],
  );

  const { list, loadingMore, loadMore } = usePaginatedList(fetchPage);

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <View className="flex-row items-end justify-between px-6 pt-6">
        <View>
          <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">Jobs</Text>
          <Text className="mt-2 font-serif text-3xl font-light text-ink">All jobs</Text>
        </View>
        {canCreate ? (
          <Pressable
            onPress={() => router.push('/jobs/new')}
            className="rounded-sm bg-ink px-4 py-2 active:bg-gold-deep"
          >
            <Text className="text-sm font-medium text-cream">+ New</Text>
          </Pressable>
        ) : null}
      </View>

      {summary ? (
        <View className="mt-4 px-6">
          {/*
            Same four questions as web. "Needs a rate" and money parked on closed
            jobs both carry `alert`: hours nobody priced cannot be billed, and a
            closed job takes its unbilled work out of the default list with it.
          */}
          <MetricStrip
            tiles={[
              {
                label: 'Open',
                value: summary.open,
                onPress: () => setStatus('open'),
                active: status === 'open',
              },
              {
                label: 'Closed',
                value: summary.closed,
                onPress: () => setStatus('closed'),
                active: status === 'closed',
              },
              {
                label: 'Ready to bill',
                value: fmt(summary.readyToBill),
                sub:
                  Number(summary.readyToBillOnClosed) > 0
                    ? `${fmt(summary.readyToBillOnClosed)} on closed`
                    : summary.jobsWithMoneyWaiting > 0
                      ? `across ${summary.jobsWithMoneyWaiting} ${summary.jobsWithMoneyWaiting === 1 ? 'job' : 'jobs'}`
                      : 'nothing waiting',
                // Shows every job, because money parked on a closed one is
                // otherwise invisible from the default view.
                onPress: () => setStatus('all'),
                alert: Number(summary.readyToBillOnClosed) > 0,
              },
              {
                label: 'Needs a rate',
                value: summary.unratedMinutes > 0 ? `${summary.unratedHours} h` : '—',
                sub: summary.unratedMinutes > 0 ? "can't be billed yet" : 'all hours priced',
                onPress: () => setStatus('all'),
                alert: summary.unratedMinutes > 0,
              },
            ]}
          />
        </View>
      ) : null}

      <View className="mt-4 px-6">
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search job name"
          returnKeyType="search"
          className="rounded-sm border border-field bg-cream-warm px-3 py-2.5 text-ink"
        />
      </View>

      {list.state === 'loading' ? (
        <View className="mt-12 items-center">
          <ActivityIndicator color="#0f1626" />
        </View>
      ) : list.state === 'error' ? (
        <Text className="mt-8 px-6 text-sm text-oxblood">Couldn't load jobs.</Text>
      ) : list.rows.length === 0 ? (
        <Text className="mt-8 px-6 text-ink-muted">
          {appliedQ
            ? 'No jobs match that search.'
            : status === 'closed'
              ? 'No closed jobs.'
              : 'No open jobs.'}
        </Text>
      ) : (
        <FlatList
          data={list.rows}
          keyExtractor={(j) => j.id}
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
              onPress={() => router.push(`/jobs/${item.id}`)}
              className="flex-row items-center justify-between bg-cream-warm px-5 py-4 active:bg-cream"
            >
              <View className="flex-1 pr-3">
                <Text className="font-serif text-lg text-ink">{item.name}</Text>
                <Text className="mt-0.5 text-xs text-ink-subtle">
                  {item.contactName ?? ''}
                  {item.status === 'closed' ? ' · closed' : ''}
                </Text>
              </View>
              {/*
                Gold only when something is actually waiting, so the column reads
                as a prompt rather than a data dump. Unpriced work gets its own
                words — $0.00 there would read as "nothing to bill".
              */}
              {Number(item.readyToBill) > 0 ? (
                <Text className="font-mono text-sm text-gold-deep">
                  {fmt(item.readyToBill)} ready
                </Text>
              ) : item.unratedMinutes > 0 ? (
                <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                  needs a rate
                </Text>
              ) : (
                <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                  {dateRange(item.startedOn, item.endedOn)}
                </Text>
              )}
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}
