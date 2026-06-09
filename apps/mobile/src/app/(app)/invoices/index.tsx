import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';
import { pageQuery, usePaginatedList } from '../../../lib/use-paginated-list';

// Mirror of apps/web's /invoices list. customerName is LEFT JOINed by the API
// now (#195), so the list no longer fetches every customer to resolve names —
// that doesn't survive pagination. Keyset infinite scroll via usePaginatedList.
type InvoiceRow = {
  id: string;
  number: string;
  customerName: string | null;
  status: string;
  dueDate: string;
  currency: string;
  total: string;
};

export default function InvoicesList() {
  const router = useRouter();

  const fetchPage = useCallback(async (cursor: string | null) => {
    const res = await api.api.invoices.$get({ query: pageQuery(cursor) });
    if (!res.ok) return null;
    const { invoices, nextCursor } = await res.json();
    return {
      rows: invoices.map(
        (i): InvoiceRow => ({
          id: i.id,
          number: i.number,
          customerName: i.customerName ?? null,
          status: i.status,
          dueDate: i.dueDate,
          currency: i.currency,
          total: i.total,
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
            Invoices
          </Text>
          <Text className="mt-2 font-serif text-3xl font-light text-ink">All invoices</Text>
        </View>
        <Pressable
          onPress={() => router.push('/invoices/new')}
          className="rounded-sm bg-ink px-4 py-2 active:bg-gold-deep"
        >
          <Text className="text-sm font-medium text-cream">+ New</Text>
        </Pressable>
      </View>

      <Pressable
        onPress={() => router.push('/invoices/recurring')}
        className="mt-4 flex-row items-center justify-between px-6 py-1"
      >
        <Text className="text-sm font-medium text-gold-deep">Recurring schedules</Text>
        <Text className="text-gold-deep">→</Text>
      </Pressable>

      {list.state === 'loading' ? (
        <View className="mt-12 items-center">
          <ActivityIndicator color="#0f1626" />
        </View>
      ) : list.state === 'error' ? (
        <Text className="mt-8 px-6 text-sm text-oxblood">Couldn't load invoices.</Text>
      ) : list.rows.length === 0 ? (
        <Text className="mt-8 px-6 text-ink/70">No invoices yet.</Text>
      ) : (
        <FlatList
          data={list.rows}
          keyExtractor={(i) => i.id}
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
                  {item.status} · {item.dueDate}
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}
