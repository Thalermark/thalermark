import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FilterChips } from '../../../components/FilterChips';
import { pickActiveCompany } from '../../../lib/active-company';
import { api } from '../../../lib/api';
import { useMay } from '../../../lib/role';
import { pageQuery, usePaginatedList } from '../../../lib/use-paginated-list';

// Mirror of apps/web's /owner-money list — money the owner puts into the
// business or takes out for themselves. The double-entry is hidden: a
// 'contribution' reads as an "Investment", a 'draw' as a "Withdrawal" — NOT
// "Money in / Money out", which the dashboard already uses for all business
// income and expenses. Keyset infinite
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
  { label: 'Investments', value: 'contribution' },
  { label: 'Withdrawals', value: 'draw' },
];

type OpeningBalance = { cash: string; receivables: string; payables: string } | null;

const money = (s: string) =>
  Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export default function OwnerMoneyList() {
  const router = useRouter();
  const canCreate = useMay('expenses:write');
  const [kind, setKind] = useState('');
  const [openingBalance, setOpeningBalance] = useState<OpeningBalance>(null);

  // The company's starting balances for the summary card (best-effort). Reloads
  // on focus so it refreshes after the user sets/edits them.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        const compRes = await api.api.companies.$get();
        if (!active || !compRes.ok) return;
        const { companies } = await compRes.json();
        const company = await pickActiveCompany(companies);
        if (!company) return;
        const obRes = await api.api['owner-money']['opening-balance'].$get({
          query: { companyId: company.id },
        });
        if (active && obRes.ok) setOpeningBalance((await obRes.json()).openingBalance);
      })().catch(() => {});
      return () => {
        active = false;
      };
    }, []),
  );

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
            Investments &amp; withdrawals
          </Text>
          <Text className="mt-2 font-serif text-3xl font-light text-ink">You and the business</Text>
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

      {canCreate ? (
        <Pressable
          onPress={() => router.push('/owner-money/opening-balance')}
          className="mx-6 mt-5 flex-row items-center justify-between gap-3 rounded-sm border border-ink/10 bg-cream-warm px-5 py-4 active:bg-cream"
        >
          <View className="flex-1">
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
              Starting balances
            </Text>
            {openingBalance ? (
              <Text className="mt-1 font-mono text-sm tabular-nums text-ink/80">
                {money(openingBalance.cash)} in the bank
              </Text>
            ) : (
              <Text className="mt-1 text-sm text-ink/60">
                Tell us what your business started with.
              </Text>
            )}
          </View>
          <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
            {openingBalance ? 'Edit' : 'Set'}
          </Text>
        </Pressable>
      ) : null}

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
                    {isIn ? 'Investment' : 'Withdrawal'}
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
