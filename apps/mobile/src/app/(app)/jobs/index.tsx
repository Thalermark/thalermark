import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';
import { useMay } from '../../../lib/role';
import { pageQuery, usePaginatedList } from '../../../lib/use-paginated-list';

// Mirror of apps/web's /jobs list. Open jobs only by default — a closed job is
// filed away, and the point of closing one is that it stops cluttering the
// places you pick from.
type JobRow = {
  id: string;
  name: string;
  status: string;
  startedOn: string | null;
  endedOn: string | null;
};

function dateRange(startedOn: string | null, endedOn: string | null): string {
  if (startedOn && endedOn) return `${startedOn} → ${endedOn}`;
  if (startedOn) return `Started ${startedOn}`;
  if (endedOn) return `Ended ${endedOn}`;
  return '';
}

export default function JobsList() {
  const router = useRouter();
  const canCreate = useMay('sales:write');
  const [showClosed, setShowClosed] = useState(false);

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const query: Record<string, string> = pageQuery(cursor);
      if (!showClosed) query.status = 'open';
      const res = await api.api.jobs.$get({ query });
      if (!res.ok) return null;
      const { jobs, nextCursor } = await res.json();
      return {
        rows: jobs.map(
          (j): JobRow => ({
            id: j.id,
            name: j.name,
            status: j.status,
            startedOn: j.startedOn,
            endedOn: j.endedOn,
          }),
        ),
        nextCursor,
      };
    },
    [showClosed],
  );

  const { list, loadingMore, loadMore } = usePaginatedList(fetchPage);

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <View className="flex-row items-end justify-between px-6 pt-6">
        <View>
          <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">Jobs</Text>
          <Text className="mt-2 font-serif text-3xl font-light text-ink">The work</Text>
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

      <View className="mt-4 px-6">
        <Pressable
          onPress={() => setShowClosed((v) => !v)}
          className={`self-start rounded-sm border px-3 py-2 ${
            showClosed ? 'border-ink bg-ink' : 'border-ink/20 bg-cream-warm'
          }`}
        >
          <Text
            className={`font-mono text-xs uppercase tracking-widest ${
              showClosed ? 'text-cream' : 'text-ink/60'
            }`}
          >
            {showClosed ? 'Showing closed' : 'Show closed'}
          </Text>
        </Pressable>
      </View>

      {list.state === 'loading' ? (
        <View className="mt-12 items-center">
          <ActivityIndicator color="#0f1626" />
        </View>
      ) : list.state === 'error' ? (
        <Text className="mt-8 px-6 text-sm text-oxblood">Couldn't load jobs.</Text>
      ) : list.rows.length === 0 ? (
        <Text className="mt-8 px-6 text-ink/70">
          {showClosed ? 'No jobs yet.' : 'No open jobs.'}
        </Text>
      ) : (
        <FlatList
          data={list.rows}
          keyExtractor={(j) => j.id}
          className="mt-6"
          contentContainerClassName="px-6 pb-6"
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
                {item.status === 'closed' ? (
                  <Text className="mt-1 font-mono text-[0.6rem] uppercase tracking-widest text-ink/40">
                    Closed
                  </Text>
                ) : null}
              </View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                {dateRange(item.startedOn, item.endedOn)}
              </Text>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}
