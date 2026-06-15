import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../../lib/api';
import { useMay } from '../../../../lib/role';
import { pageQuery, usePaginatedList } from '../../../../lib/use-paginated-list';

// Mirror of apps/web's /settings/tax-policies. Account-scoped via x-account-id;
// keyset infinite scroll. Archived policies hide until "Show archived". Policies
// archive/restore instead of deleting. Writes are settings:manage.
type PolicyRow = {
  id: string;
  name: string;
  ratePct: string;
  isDefault: boolean;
  archivedAt: string | null;
};

const rate = (s: string) => `${Number(s)}%`;

export default function TaxPoliciesList() {
  const router = useRouter();
  const canManage = useMay('settings:manage');
  const [showArchived, setShowArchived] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const query = pageQuery(cursor);
      if (showArchived) query.includeArchived = 'true';
      const res = await api.api['tax-policies'].$get({ query });
      if (!res.ok) return null;
      const { taxPolicies, nextCursor } = await res.json();
      return {
        rows: taxPolicies.map(
          (p): PolicyRow => ({
            id: p.id,
            name: p.name,
            ratePct: p.ratePct,
            isDefault: p.isDefault,
            archivedAt: p.archivedAt ?? null,
          }),
        ),
        nextCursor,
      };
    },
    [showArchived],
  );

  const { list, loadingMore, loadMore, reload } = usePaginatedList(fetchPage);

  async function toggleArchive(policy: PolicyRow) {
    setBusyId(policy.id);
    try {
      const res = policy.archivedAt
        ? await api.api['tax-policies'][':id'].restore.$post({ param: { id: policy.id } })
        : await api.api['tax-policies'][':id'].archive.$post({ param: { id: policy.id } });
      if (res.ok) reload();
    } catch {
      // A focus refetch will reconcile.
    } finally {
      setBusyId(null);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <View className="px-6 pt-6">
        <Pressable onPress={() => router.push('/more')}>
          <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">← More</Text>
        </Pressable>
        <View className="mt-3 flex-row items-end justify-between">
          <Text className="font-serif text-3xl font-light text-ink">Tax policies</Text>
          {canManage ? (
            <Pressable
              onPress={() => router.push('/more/tax-policies/new')}
              className="rounded-sm bg-ink px-4 py-2 active:bg-gold-deep"
            >
              <Text className="text-sm font-medium text-cream">+ New</Text>
            </Pressable>
          ) : null}
        </View>
        <Pressable onPress={() => setShowArchived((s) => !s)} className="mt-4 self-start">
          <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
            {showArchived ? '← Hide archived' : 'Show archived'}
          </Text>
        </Pressable>
      </View>

      {list.state === 'loading' ? (
        <View className="mt-12 items-center">
          <ActivityIndicator color="#0f1626" />
        </View>
      ) : list.state === 'error' ? (
        <Text className="mt-8 px-6 text-sm text-oxblood">Couldn't load tax policies.</Text>
      ) : list.rows.length === 0 ? (
        <Text className="mt-8 px-6 text-ink/70">
          {showArchived ? 'No tax policies yet.' : 'No active tax policies yet.'}
        </Text>
      ) : (
        <FlatList
          data={list.rows}
          keyExtractor={(p) => p.id}
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
            <View className="flex-row items-center gap-3 bg-cream-warm px-5 py-4">
              <Pressable
                onPress={() => router.push(`/more/tax-policies/${item.id}`)}
                className="flex-1 active:opacity-70"
              >
                <View className="flex-row items-center gap-2">
                  <Text className="font-serif text-lg text-ink">{item.name}</Text>
                  {item.isDefault ? (
                    <Text className="rounded-sm border border-gold-deep/40 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-widest text-gold-deep">
                      Default
                    </Text>
                  ) : null}
                  {item.archivedAt ? (
                    <Text className="rounded-sm border border-ink/15 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-widest text-ink/50">
                      Archived
                    </Text>
                  ) : null}
                </View>
                <Text className="mt-1 font-mono text-xs uppercase tracking-widest text-ink/50">
                  {rate(item.ratePct)}
                </Text>
              </Pressable>
              {canManage ? (
                <Pressable
                  onPress={() => toggleArchive(item)}
                  disabled={busyId === item.id}
                  className="rounded-sm border border-ink/15 px-2 py-1 active:border-gold-deep disabled:opacity-50"
                >
                  <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
                    {item.archivedAt ? 'Restore' : 'Archive'}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}
