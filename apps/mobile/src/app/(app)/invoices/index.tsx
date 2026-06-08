import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';

// Mirror of apps/web's /invoices list. The API returns invoice rows with
// customerId (not name), so — like web's loader — we fetch customers too and
// join the name client-side. Account-scoped via x-account-id.
type InvoiceRow = {
  id: string;
  number: string;
  customerId: string;
  status: string;
  dueDate: string;
  currency: string;
  total: string;
};
type ListState =
  | { state: 'loading' }
  | { state: 'ready'; invoices: InvoiceRow[]; names: Record<string, string> }
  | { state: 'error' };

export default function InvoicesList() {
  const router = useRouter();
  const [list, setList] = useState<ListState>({ state: 'loading' });

  useFocusEffect(
    useCallback(() => {
      let active = true;
      Promise.all([api.api.invoices.$get(), api.api.customers.$get()])
        .then(async ([invRes, custRes]) => {
          if (!active) return;
          if (!invRes.ok) {
            setList({ state: 'error' });
            return;
          }
          const { invoices } = await invRes.json();
          const names: Record<string, string> = {};
          if (custRes.ok) {
            const { customers } = await custRes.json();
            for (const c of customers) names[c.id] = c.name;
          }
          setList({
            state: 'ready',
            invoices: invoices.map((i) => ({
              id: i.id,
              number: i.number,
              customerId: i.customerId,
              status: i.status,
              dueDate: i.dueDate,
              currency: i.currency,
              total: i.total,
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

      {list.state === 'loading' ? (
        <View className="mt-12 items-center">
          <ActivityIndicator color="#0f1626" />
        </View>
      ) : list.state === 'error' ? (
        <Text className="mt-8 px-6 text-sm text-oxblood">Couldn't load invoices.</Text>
      ) : list.invoices.length === 0 ? (
        <Text className="mt-8 px-6 text-ink/70">No invoices yet.</Text>
      ) : (
        <FlatList
          data={list.invoices}
          keyExtractor={(i) => i.id}
          className="mt-6"
          contentContainerClassName="px-6 pb-6"
          ItemSeparatorComponent={() => <View className="h-px bg-ink/10" />}
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
                <Text className="text-sm text-ink/70">{list.names[item.customerId] ?? '—'}</Text>
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
