import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';

// Mirror of apps/web's /expenses list. Rows show merchant / amount / date —
// the category lives behind a COA account UUID we don't resolve in the list
// (kept lean; the detail screen resolves names).
type ExpenseRow = { id: string; merchant: string; amount: string; expenseDate: string };
type ListState =
  | { state: 'loading' }
  | { state: 'ready'; expenses: ExpenseRow[] }
  | { state: 'error' };

export default function ExpensesList() {
  const router = useRouter();
  const [list, setList] = useState<ListState>({ state: 'loading' });

  useFocusEffect(
    useCallback(() => {
      let active = true;
      api.api.expenses
        .$get()
        .then(async (res) => {
          if (!active) return;
          if (!res.ok) {
            setList({ state: 'error' });
            return;
          }
          const { expenses } = await res.json();
          setList({
            state: 'ready',
            expenses: expenses.map((e) => ({
              id: e.id,
              merchant: e.merchant,
              amount: e.amount,
              expenseDate: e.expenseDate,
            })),
          });
        })
        .catch(() => {
          if (active) setList({ state: 'error' });
        });
      return () => {
        active = false;
      };
    }, []),
  );

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <View className="flex-row items-end justify-between px-6 pt-6">
        <View>
          <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
            Expenses
          </Text>
          <Text className="mt-2 font-serif text-3xl font-light text-ink">All expenses</Text>
        </View>
        <Pressable
          onPress={() => router.push('/expenses/new')}
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
        <Text className="mt-8 px-6 text-sm text-oxblood">Couldn't load expenses.</Text>
      ) : list.expenses.length === 0 ? (
        <Text className="mt-8 px-6 text-ink/70">No expenses yet.</Text>
      ) : (
        <FlatList
          data={list.expenses}
          keyExtractor={(e) => e.id}
          className="mt-6"
          contentContainerClassName="px-6 pb-6"
          ItemSeparatorComponent={() => <View className="h-px bg-ink/10" />}
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
