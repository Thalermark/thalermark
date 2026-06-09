import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';
import { pageQuery, usePaginatedList } from '../../../lib/use-paginated-list';

// Mirror of apps/web's /customers list. Account-scoped via x-account-id (the
// API filters by accountId); keyset-paginated with onEndReached infinite scroll.
// usePaginatedList refetches page 1 on focus so a customer created on
// /customers/new shows when we navigate back.
type CustomerRow = { id: string; name: string; email: string | null };

export default function CustomersList() {
  const router = useRouter();

  const fetchPage = useCallback(async (cursor: string | null) => {
    const res = await api.api.customers.$get({ query: pageQuery(cursor) });
    if (!res.ok) return null;
    const { customers, nextCursor } = await res.json();
    return {
      rows: customers.map((c): CustomerRow => ({ id: c.id, name: c.name, email: c.email ?? null })),
      nextCursor,
    };
  }, []);

  const { list, loadingMore, loadMore } = usePaginatedList(fetchPage);

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
      ) : list.rows.length === 0 ? (
        <Text className="mt-8 px-6 text-ink/70">No customers yet.</Text>
      ) : (
        <FlatList
          data={list.rows}
          keyExtractor={(c) => c.id}
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
