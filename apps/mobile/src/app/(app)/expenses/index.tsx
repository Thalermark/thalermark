import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';
import { useMay } from '../../../lib/role';
import { pageQuery, usePaginatedList } from '../../../lib/use-paginated-list';

// Mirror of apps/web's /expenses list. Rows show merchant / amount / date —
// the category lives behind a COA account UUID we don't resolve in the list
// (kept lean; the detail screen resolves names). Keyset infinite scroll.
type ExpenseRow = { id: string; merchant: string; amount: string; expenseDate: string };

export default function ExpensesList() {
  const router = useRouter();
  const canCreate = useMay('expenses:write');

  const fetchPage = useCallback(async (cursor: string | null) => {
    const res = await api.api.expenses.$get({ query: pageQuery(cursor) });
    if (!res.ok) return null;
    const { expenses, nextCursor } = await res.json();
    return {
      rows: expenses.map(
        (e): ExpenseRow => ({
          id: e.id,
          merchant: e.merchant,
          amount: e.amount,
          expenseDate: e.expenseDate,
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
            Expenses
          </Text>
          <Text className="mt-2 font-serif text-3xl font-light text-ink">All expenses</Text>
        </View>
        {canCreate ? (
          <Pressable
            onPress={() => router.push('/expenses/new')}
            className="rounded-sm bg-ink px-4 py-2 active:bg-gold-deep"
          >
            <Text className="text-sm font-medium text-cream">+ New</Text>
          </Pressable>
        ) : null}
      </View>

      {list.state === 'loading' ? (
        <View className="mt-12 items-center">
          <ActivityIndicator color="#0f1626" />
        </View>
      ) : list.state === 'error' ? (
        <Text className="mt-8 px-6 text-sm text-oxblood">Couldn't load expenses.</Text>
      ) : list.rows.length === 0 ? (
        <Text className="mt-8 px-6 text-ink/70">No expenses yet.</Text>
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
              onPress={() => router.push(`/expenses/${item.id}`)}
              className="flex-row items-center justify-between bg-cream-warm px-5 py-4 active:bg-cream"
            >
              <View>
                <Text className="font-serif text-lg text-ink">{item.merchant}</Text>
                <Text className="mt-1 font-mono text-xs uppercase tracking-widest text-ink/50">
                  {item.expenseDate}
                </Text>
              </View>
              <Text className="font-mono tabular-nums text-ink">{item.amount}</Text>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}
