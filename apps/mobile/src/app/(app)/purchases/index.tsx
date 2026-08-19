import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';
import { useMay } from '../../../lib/role';
import { pageQuery, usePaginatedList } from '../../../lib/use-paginated-list';

// Mirror of apps/web's /purchases — "big purchases": durable gear bought and
// used for years. The API LEFT JOINs the vendor name and derives the per-row
// loan balance, so the list shows what / cost / still-owed without extra
// lookups. Keyset infinite scroll. Reached from the Expenses-new branch.
type PurchaseRow = {
  id: string;
  description: string;
  amount: string;
  purchaseDate: string;
  funding: string;
  owing: string;
  vendorName: string | null;
};

const money = (s: string) =>
  Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export default function PurchasesList() {
  const router = useRouter();
  const canCreate = useMay('expenses:write');

  const fetchPage = useCallback(async (cursor: string | null) => {
    const res = await api.api.purchases.$get({ query: pageQuery(cursor) });
    if (!res.ok) return null;
    const { purchases, nextCursor } = await res.json();
    return {
      rows: purchases.map(
        (p): PurchaseRow => ({
          id: p.id,
          description: p.description,
          amount: p.amount,
          purchaseDate: p.purchaseDate,
          funding: p.funding,
          owing: p.owing,
          vendorName: p.vendorName,
        }),
      ),
      nextCursor,
    };
  }, []);

  const { list, loadingMore, loadMore } = usePaginatedList(fetchPage);

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      {/* Expenses is this screen's parent, same as on web. Load-bearing here
          rather than cosmetic: the tab bar hides purchases (href: null), so
          without this there is no way out except the OS back gesture. */}
      <View className="px-6 pt-6">
        <Pressable onPress={() => router.push('/expenses')}>
          <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
            ← Expenses
          </Text>
        </Pressable>

        <View className="mt-3 flex-row items-end justify-between">
          <Text className="font-serif text-3xl font-light text-ink">Things you bought</Text>
          {canCreate ? (
            <Pressable
              onPress={() => router.push('/purchases/new')}
              className="rounded-sm bg-ink px-4 py-2 active:bg-gold-deep"
            >
              <Text className="text-sm font-medium text-cream">+ Log</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {list.state === 'loading' ? (
        <View className="mt-12 items-center">
          <ActivityIndicator color="#0f1626" />
        </View>
      ) : list.state === 'error' ? (
        <Text className="mt-8 px-6 text-sm text-oxblood">Couldn't load this.</Text>
      ) : list.rows.length === 0 ? (
        <Text className="mt-8 px-6 text-ink-muted">Nothing logged yet.</Text>
      ) : (
        <FlatList
          data={list.rows}
          keyExtractor={(p) => p.id}
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
          renderItem={({ item }) => {
            const stillOwes = Number(item.owing) > 0;
            return (
              <Pressable
                onPress={() => router.push(`/purchases/${item.id}`)}
                className="bg-cream-warm px-5 py-4 active:bg-cream"
              >
                <View className="flex-row items-center justify-between">
                  <Text className="flex-1 pr-3 font-serif text-lg text-ink" numberOfLines={1}>
                    {item.description}
                  </Text>
                  <Text className="font-mono tabular-nums text-ink">{money(item.amount)}</Text>
                </View>
                <View className="mt-1 flex-row items-center justify-between">
                  <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                    {item.purchaseDate}
                    {item.vendorName ? ` · ${item.vendorName}` : ''}
                  </Text>
                  {stillOwes ? (
                    <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                      owe {money(item.owing)}
                    </Text>
                  ) : (
                    <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                      Paid off
                    </Text>
                  )}
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}
