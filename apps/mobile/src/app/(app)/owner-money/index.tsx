import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FilterChips } from '../../../components/FilterChips';
import { api } from '../../../lib/api';
import { useMay } from '../../../lib/role';
import { pageQuery, usePaginatedList } from '../../../lib/use-paginated-list';

// Mirror of apps/web's /owner-money list — money the owner puts into the
// business or takes out for themselves. The double-entry is hidden: a
// 'contribution' reads as "Money in", a 'draw' as "Money out". Keyset infinite
// scroll via usePaginatedList; the kind chip flips fetchPage's identity, which
// reloads page 1. Unscoped by company like the expenses/bills lists.
type EventRow = {
  id: string;
  kind: string;
  amount: string;
  occurredOn: string;
  memo: string | null;
};

const KIND_OPTIONS = [
  { label: 'All', value: '' },
  { label: 'Money in', value: 'contribution' },
  { label: 'Money out', value: 'draw' },
];

export default function OwnerMoneyList() {
  const router = useRouter();
  const canCreate = useMay('expenses:write');
  const [kind, setKind] = useState('');

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const query = pageQuery(cursor);
      if (kind) query.kind = kind;
      const res = await api.api['owner-money'].$get({ query });
      if (!res.ok) return null;
      const { events, nextCursor } = await res.json();
      return {
        rows: events.map(
          (e): EventRow => ({
            id: e.id,
            kind: e.kind,
            amount: e.amount,
            occurredOn: e.occurredOn,
            memo: e.memo,
          }),
        ),
        nextCursor,
      };
    },
    [kind],
  );

  const { list, loadingMore, loadMore } = usePaginatedList(fetchPage);

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <View className="flex-row items-end justify-between px-6 pt-6">
        <View>
          <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
            Owner money
          </Text>
          <Text className="mt-2 font-serif text-3xl font-light text-ink">
            Your money in &amp; out
          </Text>
        </View>
        {canCreate ? (
          <Pressable
            onPress={() => router.push('/owner-money/new')}
            className="rounded-sm bg-ink px-4 py-2 active:bg-gold-deep"
          >
            <Text className="text-sm font-medium text-cream">+ Record</Text>
          </Pressable>
        ) : null}
      </View>

      <View className="mt-4">
        <FilterChips options={KIND_OPTIONS} value={kind} onChange={setKind} />
      </View>

      {list.state === 'loading' ? (
        <View className="mt-12 items-center">
          <ActivityIndicator color="#0f1626" />
        </View>
      ) : list.state === 'error' ? (
        <Text className="mt-8 px-6 text-sm text-oxblood">Couldn't load this.</Text>
      ) : list.rows.length === 0 ? (
        <Text className="mt-8 px-6 text-ink/70">
          {kind ? 'Nothing matches this filter.' : 'Nothing recorded yet.'}
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
                <ActivityIndicator color="#0f1626" />
              </View>
            ) : null
          }
          renderItem={({ item }) => {
            const isIn = item.kind === 'contribution';
            return (
              <Pressable
                onPress={() => router.push(`/owner-money/${item.id}`)}
                className="bg-cream-warm px-5 py-4 active:bg-cream"
              >
                <View className="flex-row items-center justify-between">
                  <Text className="flex-1 pr-3 font-serif text-lg text-ink">
                    {isIn ? 'Money in' : 'Money out'}
                  </Text>
                  <Text
                    className={`font-mono tabular-nums ${isIn ? 'text-gold-deep' : 'text-ink'}`}
                  >
                    {isIn ? '+' : '−'}
                    {item.amount}
                  </Text>
                </View>
                <View className="mt-1 flex-row items-center justify-between">
                  <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                    {item.occurredOn}
                  </Text>
                  {item.memo ? (
                    <Text className="flex-1 pl-3 text-right text-xs text-ink/50" numberOfLines={1}>
                      {item.memo}
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
