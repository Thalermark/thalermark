import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../../lib/api';
import { useMay } from '../../../../lib/role';
import { pageQuery, usePaginatedList } from '../../../../lib/use-paginated-list';

// Repeating invoices list. Lives in the invoices Stack (reached via the
// "Repeating invoices →" link on the invoices list), not its own tab. Mirror
// of apps/web's /recurring. customerName is LEFT JOINed by the API (#195);
// keyset infinite scroll via usePaginatedList.
type RecurringRow = {
  id: string;
  customerName: string | null;
  status: string;
  frequency: string;
  intervalCount: number;
  nextRunDate: string;
  currency: string;
  total: string;
};

function cadenceLabel(frequency: string, interval: number): string {
  const unit = frequency === 'weekly' ? 'week' : frequency === 'monthly' ? 'month' : 'year';
  return interval === 1 ? `Every ${unit}` : `Every ${interval} ${unit}s`;
}

export default function RecurringList() {
  const router = useRouter();
  const canCreate = useMay('sales:write');

  const fetchPage = useCallback(async (cursor: string | null) => {
    const res = await api.api['recurring-invoices'].$get({ query: pageQuery(cursor) });
    if (!res.ok) return null;
    const { recurringInvoices, nextCursor } = await res.json();
    return {
      rows: recurringInvoices.map(
        (r): RecurringRow => ({
          id: r.id,
          customerName: r.customerName ?? null,
          status: r.status,
          frequency: r.frequency,
          intervalCount: r.intervalCount,
          nextRunDate: r.nextRunDate,
          currency: r.currency,
          total: r.total,
        }),
      ),
      nextCursor,
    };
  }, []);

  const { list, loadingMore, loadMore } = usePaginatedList(fetchPage);

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <View className="px-6 pt-6">
        <Text
          onPress={() => router.push('/invoices')}
          className="font-mono text-xs uppercase tracking-widest text-ink-subtle"
        >
          ← Invoices
        </Text>
        <View className="mt-2 flex-row items-end justify-between">
          <Text className="font-serif text-3xl font-light text-ink">Repeating</Text>
          {canCreate ? (
            <Pressable
              onPress={() => router.push('/invoices/recurring/new')}
              className="rounded-sm bg-ink px-4 py-2 active:bg-gold-deep"
            >
              <Text className="text-sm font-medium text-cream">+ New</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {list.state === 'loading' ? (
        <View className="mt-12 items-center">
          <ActivityIndicator color="#0f1626" />
        </View>
      ) : list.state === 'error' ? (
        <Text className="mt-8 px-6 text-sm text-oxblood">Couldn't load schedules.</Text>
      ) : list.rows.length === 0 ? (
        <Text className="mt-8 px-6 text-ink-muted">No recurring schedules yet.</Text>
      ) : (
        <FlatList
          data={list.rows}
          keyExtractor={(r) => r.id}
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
              onPress={() => router.push(`/invoices/recurring/${item.id}`)}
              className="bg-cream-warm px-5 py-4 active:bg-cream"
            >
              <View className="flex-row items-center justify-between">
                <Text className="font-serif text-lg text-ink">{item.customerName ?? '—'}</Text>
                <Text className="font-mono tabular-nums text-ink">
                  {item.currency} {item.total}
                </Text>
              </View>
              <View className="mt-1 flex-row items-center justify-between">
                <Text className="text-sm text-ink-muted">
                  {cadenceLabel(item.frequency, item.intervalCount)}
                </Text>
                <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                  {item.status}
                  {item.status !== 'ended' ? ` · next ${item.nextRunDate}` : ''}
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}
