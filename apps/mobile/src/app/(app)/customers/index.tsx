import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';

// Mirror of apps/web's /customers list. Account-scoped via x-account-id (the
// API filters by accountId); single-company MVP lists them all. Refetches on
// focus so a customer created on /customers/new shows when we navigate back.
type CustomerRow = { id: string; name: string; email: string | null };
type ListState =
  | { state: 'loading' }
  | { state: 'ready'; customers: CustomerRow[] }
  | { state: 'error' };

export default function CustomersList() {
  const router = useRouter();
  const [list, setList] = useState<ListState>({ state: 'loading' });

  useFocusEffect(
    useCallback(() => {
      let active = true;
      api.api.customers
        .$get()
        .then(async (res) => {
          if (!active) return;
          if (!res.ok) {
            setList({ state: 'error' });
            return;
          }
          const { customers } = await res.json();
          setList({
            state: 'ready',
            customers: customers.map((c) => ({ id: c.id, name: c.name, email: c.email ?? null })),
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
            Customers
          </Text>
          <Text className="mt-2 font-serif text-3xl font-light text-ink">All customers</Text>
        </View>
        <Pressable
          onPress={() => router.push('/customers/new')}
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
        <Text className="mt-8 px-6 text-sm text-oxblood">Couldn't load customers.</Text>
      ) : list.customers.length === 0 ? (
        <Text className="mt-8 px-6 text-ink/70">No customers yet.</Text>
      ) : (
        <FlatList
          data={list.customers}
          keyExtractor={(c) => c.id}
          className="mt-6"
          contentContainerClassName="px-6 pb-6"
          ItemSeparatorComponent={() => <View className="h-px bg-ink/10" />}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push(`/customers/${item.id}`)}
              className="flex-row items-center justify-between bg-cream-warm px-5 py-4 active:bg-cream"
            >
              <Text className="font-serif text-lg text-ink">{item.name}</Text>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                {item.email ?? ''}
              </Text>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}
