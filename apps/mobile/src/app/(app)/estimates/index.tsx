import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';
import { pageQuery, usePaginatedList } from '../../../lib/use-paginated-list';

// Mirror of apps/web's /estimates list. customerName is LEFT JOINed by the API
// (#195); keyset infinite scroll via usePaginatedList.
type EstimateRow = {
  id: string;
  number: string;
  customerName: string | null;
  status: string;
  issueDate: string;
  currency: string;
  total: string;
};

export default function EstimatesList() {
  const router = useRouter();

  const fetchPage = useCallback(async (cursor: string | null) => {
    const res = await api.api.estimates.$get({ query: pageQuery(cursor) });
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
  }, []);

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
        <Pressable
          onPress={() => router.push('/estimates/new')}
          className="rounded-sm bg-ink px-4 py-2 active:bg-gold-deep"
        >
          <Text className="text-sm font-medium text-cream">+ New</Text>
        </Pressable>
      </View>

      {list.state === 'loading' ? (
        <View className="mt-12 items-center">
          <ActivityIndicator color="#0f1626" />
        </View>
      ) : list.state === 'error' ? (
        <Text className="mt-8 px-6 text-sm text-oxblood">Couldn't load estimates.</Text>
      ) : list.rows.length === 0 ? (
        <Text className="mt-8 px-6 text-ink/70">No estimates yet.</Text>
      ) : (
        <FlatList
          data={list.rows}
          keyExtractor={(e) => e.id}
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
                <Text className="text-sm text-ink/70">{item.customerName ?? '—'}</Text>
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
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
