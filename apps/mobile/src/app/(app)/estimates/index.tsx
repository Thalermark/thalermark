import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';

// Mirror of apps/web's /estimates list (and the mobile invoices list). The API
// returns rows with customerId only, so — like invoices — fetch customers and
// join the name client-side.
type EstimateRow = {
  id: string;
  number: string;
  customerId: string;
  status: string;
  issueDate: string;
  currency: string;
  total: string;
};
type ListState =
  | { state: 'loading' }
  | { state: 'ready'; estimates: EstimateRow[]; names: Record<string, string> }
  | { state: 'error' };

export default function EstimatesList() {
  const router = useRouter();
  const [list, setList] = useState<ListState>({ state: 'loading' });

  useFocusEffect(
    useCallback(() => {
      let active = true;
      Promise.all([api.api.estimates.$get(), api.api.customers.$get()])
        .then(async ([estRes, custRes]) => {
          if (!active) return;
          if (!estRes.ok) {
            setList({ state: 'error' });
            return;
          }
          const { estimates } = await estRes.json();
          const names: Record<string, string> = {};
          if (custRes.ok) {
            const { customers } = await custRes.json();
            for (const c of customers) names[c.id] = c.name;
          }
          setList({
            state: 'ready',
            estimates: estimates.map((e) => ({
              id: e.id,
              number: e.number,
              customerId: e.customerId,
              status: e.status,
              issueDate: e.issueDate,
              currency: e.currency,
              total: e.total,
            })),
            names,
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
      ) : list.estimates.length === 0 ? (
        <Text className="mt-8 px-6 text-ink/70">No estimates yet.</Text>
      ) : (
        <FlatList
          data={list.estimates}
          keyExtractor={(e) => e.id}
          className="mt-6"
          contentContainerClassName="px-6 pb-6"
          ItemSeparatorComponent={() => <View className="h-px bg-ink/10" />}
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
                <Text className="text-sm text-ink/70">{list.names[item.customerId] ?? '—'}</Text>
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
