import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FilterChips } from '../../../components/FilterChips';
import { api } from '../../../lib/api';
import { useMay } from '../../../lib/role';
import { pageQuery, usePaginatedList } from '../../../lib/use-paginated-list';

// Mirror of apps/web's /bills list — accounts payable, the money you owe
// vendors. The API LEFT JOINs the vendor name onto each row, so the list shows
// vendor / due date / status / amount without resolving contacts. Keyset
// infinite scroll via usePaginatedList; the status chip flips fetchPage's
// identity, which reloads page 1. Unscoped by company like the invoices/expenses
// lists (the active-company tile on the dashboard is the company-scoped view).
type BillRow = {
  id: string;
  vendorName: string;
  dueDate: string;
  amount: string;
  status: string;
  reference: string | null;
};

const STATUS_OPTIONS = [
  { label: 'All', value: '' },
  { label: 'Open', value: 'open' },
  { label: 'Paid', value: 'paid' },
  { label: 'Voided', value: 'voided' },
];

const todayIso = () => new Date().toISOString().slice(0, 10);

export default function BillsList() {
  const router = useRouter();
  const canCreate = useMay('expenses:write');
  const [status, setStatus] = useState('');
  const today = todayIso();

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const query = pageQuery(cursor);
      if (status) query.status = status;
      const res = await api.api.bills.$get({ query });
      if (!res.ok) return null;
      const { bills, nextCursor } = await res.json();
      return {
        rows: bills.map(
          (b): BillRow => ({
            id: b.id,
            vendorName: b.vendorName,
            dueDate: b.dueDate,
            amount: b.amount,
            status: b.status,
            reference: b.reference,
          }),
        ),
        nextCursor,
      };
    },
    [status],
  );

  const { list, loadingMore, loadMore } = usePaginatedList(fetchPage);

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <View className="flex-row items-end justify-between px-6 pt-6">
        <View>
          <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">Bills</Text>
          <Text className="mt-2 font-serif text-3xl font-light text-ink">What you owe</Text>
        </View>
        {canCreate ? (
          <Pressable
            onPress={() => router.push('/bills/new')}
            className="rounded-sm bg-ink px-4 py-2 active:bg-gold-deep"
          >
            <Text className="text-sm font-medium text-cream">+ New</Text>
          </Pressable>
        ) : null}
      </View>

      <Pressable
        onPress={() => router.push('/bills/aging')}
        className="mt-4 flex-row items-center justify-between px-6 py-1"
      >
        <Text className="text-sm font-medium text-gold-deep">Who to pay first</Text>
        <Text className="text-gold-deep">→</Text>
      </Pressable>

      <View className="mt-3">
        <FilterChips options={STATUS_OPTIONS} value={status} onChange={setStatus} />
      </View>

      {list.state === 'loading' ? (
        <View className="mt-12 items-center">
          <ActivityIndicator color="#0f1626" />
        </View>
      ) : list.state === 'error' ? (
        <Text className="mt-8 px-6 text-sm text-oxblood">Couldn't load bills.</Text>
      ) : list.rows.length === 0 ? (
        <Text className="mt-8 px-6 text-ink/70">
          {status ? 'No bills with this status.' : 'No bills yet.'}
        </Text>
      ) : (
        <FlatList
          data={list.rows}
          keyExtractor={(b) => b.id}
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
            const overdue = item.status === 'open' && item.dueDate < today;
            return (
              <Pressable
                onPress={() => router.push(`/bills/${item.id}`)}
                className="bg-cream-warm px-5 py-4 active:bg-cream"
              >
                <View className="flex-row items-center justify-between">
                  <Text className="flex-1 pr-3 font-serif text-lg text-ink" numberOfLines={1}>
                    {item.vendorName}
                    {item.reference ? (
                      <Text className="font-mono text-xs text-ink/40"> #{item.reference}</Text>
                    ) : null}
                  </Text>
                  <Text className="font-mono tabular-nums text-ink">{item.amount}</Text>
                </View>
                <View className="mt-1 flex-row items-center justify-between">
                  <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                    {item.status} · due {item.dueDate}
                  </Text>
                  {overdue ? (
                    <Text className="font-mono text-xs uppercase tracking-widest text-oxblood">
                      Overdue
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}
