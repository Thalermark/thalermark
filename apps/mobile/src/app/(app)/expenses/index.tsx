import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';
import { useMay } from '../../../lib/role';
import { pageQuery, usePaginatedList } from '../../../lib/use-paginated-list';

// Mirror of apps/web's /expenses list. Rows show the vendor (merchant) / amount
// / date — the category lives behind a COA account UUID we don't resolve in the
// list (kept lean; the detail screen resolves names). Keyset infinite scroll.
type ExpenseRow = {
  id: string;
  merchant: string;
  amount: string;
  expenseDate: string;
  needsReview: boolean;
};

export default function ExpensesList() {
  const router = useRouter();
  const canCreate = useMay('expenses:write');
  // "Needs review": receipt-backed expenses with no vendor linked. Toggling it
  // changes fetchPage's identity, which usePaginatedList re-runs from page 1.
  const [needsReview, setNeedsReview] = useState(false);

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const query = pageQuery(cursor);
      if (needsReview) query.needsReview = 'true';
      const res = await api.api.expenses.$get({ query });
      if (!res.ok) return null;
      const { expenses, nextCursor } = await res.json();
      return {
        rows: expenses.map(
          (e): ExpenseRow => ({
            id: e.id,
            merchant: e.merchant,
            amount: e.amount,
            expenseDate: e.expenseDate,
            needsReview: e.vendorReview === 'needs_review',
          }),
        ),
        nextCursor,
      };
    },
    [needsReview],
  );

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

      {/* Mirrors web's /expenses header link. The tab bar hides purchases on
          purpose, so Expenses is the only way back to the list after logging
          one through the New-expense fork. */}
      <Pressable
        onPress={() => router.push('/purchases')}
        className="mt-4 flex-row items-center justify-between px-6 py-1"
      >
        <Text className="text-sm font-medium text-gold-deep">Big purchases</Text>
        <Text className="text-gold-deep">→</Text>
      </Pressable>

      <View className="px-6 pt-4">
        <Pressable
          onPress={() => setNeedsReview((v) => !v)}
          className={`self-start rounded-sm border px-3 py-1.5 ${needsReview ? 'border-gold-deep bg-gold-deep/10' : 'border-ink/15'}`}
        >
          <Text
            className={`font-mono text-xs uppercase tracking-widest ${needsReview ? 'text-gold-deep' : 'text-ink-subtle'}`}
          >
            Needs review
          </Text>
        </Pressable>
      </View>

      {list.state === 'loading' ? (
        <View className="mt-12 items-center">
          <ActivityIndicator className="text-ink" />
        </View>
      ) : list.state === 'error' ? (
        <Text className="mt-8 px-6 text-sm text-oxblood">Couldn't load expenses.</Text>
      ) : list.rows.length === 0 ? (
        <Text className="mt-8 px-6 text-ink-muted">
          {needsReview ? 'Nothing needs review.' : 'No expenses yet.'}
        </Text>
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
                <ActivityIndicator className="text-ink" />
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push(`/expenses/${item.id}`)}
              className="flex-row items-center justify-between bg-cream-warm px-5 py-4 active:bg-cream"
            >
              <View className="flex-1 pr-3">
                <View className="flex-row items-center gap-2">
                  <Text className="font-serif text-lg text-ink" numberOfLines={1}>
                    {item.merchant}
                  </Text>
                  {item.needsReview ? (
                    <View className="rounded-sm bg-gold-deep/15 px-1.5 py-0.5">
                      <Text className="font-mono text-[10px] uppercase tracking-wide text-gold-deep">
                        Review
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Text className="mt-1 font-mono text-xs uppercase tracking-widest text-ink-subtle">
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
