import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../../lib/api';

// Mirror of apps/web's /settings/items. Account-scoped via x-account-id (the API
// filters by accountId); single-company MVP lists them all. Archived items are
// hidden until the "Show archived" toggle flips includeArchived=true. Items
// archive/restore instead of deleting — there's no item DELETE endpoint.
type ItemRow = {
  id: string;
  name: string;
  unitPrice: string;
  unitLabel: string | null;
  archivedAt: string | null;
};
type ListState = { state: 'loading' } | { state: 'ready'; items: ItemRow[] } | { state: 'error' };

const fmt = (s: string) =>
  Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const priceLabel = (unitPrice: string, unitLabel: string | null) =>
  unitLabel ? `${fmt(unitPrice)} / ${unitLabel}` : fmt(unitPrice);

export default function ItemsList() {
  const router = useRouter();
  const [showArchived, setShowArchived] = useState(false);
  const [list, setList] = useState<ListState>({ state: 'loading' });
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(
    (active: () => boolean) => {
      api.api.items
        .$get({ query: { includeArchived: showArchived ? 'true' : undefined } })
        .then(async (res) => {
          if (!active()) return;
          if (!res.ok) {
            setList({ state: 'error' });
            return;
          }
          const { items } = await res.json();
          setList({
            state: 'ready',
            items: items.map((i) => ({
              id: i.id,
              name: i.name,
              unitPrice: i.unitPrice,
              unitLabel: i.unitLabel ?? null,
              archivedAt: i.archivedAt ?? null,
            })),
          });
        })
        .catch(() => {
          if (active()) setList({ state: 'error' });
        });
    },
    [showArchived],
  );

  // Refetch on focus (so an item created/edited on a child screen shows on
  // return) and whenever the archived toggle flips.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      load(() => alive);
      return () => {
        alive = false;
      };
    }, [load]),
  );

  async function toggleArchive(item: ItemRow) {
    setBusyId(item.id);
    try {
      const res = item.archivedAt
        ? await api.api.items[':id'].restore.$post({ param: { id: item.id } })
        : await api.api.items[':id'].archive.$post({ param: { id: item.id } });
      if (res.ok) load(() => true);
    } catch {
      // Leave the row as-is; a focus refetch will reconcile.
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
          <Text className="font-serif text-3xl font-light text-ink">Products &amp; services</Text>
          <Pressable
            onPress={() => router.push('/more/items/new')}
            className="rounded-sm bg-ink px-4 py-2 active:bg-gold-deep"
          >
            <Text className="text-sm font-medium text-cream">+ New</Text>
          </Pressable>
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
        <Text className="mt-8 px-6 text-sm text-oxblood">Couldn't load items.</Text>
      ) : list.items.length === 0 ? (
        <Text className="mt-8 px-6 text-ink/70">
          {showArchived ? 'No items yet.' : 'No active items yet.'}
        </Text>
      ) : (
        <FlatList
          data={list.items}
          keyExtractor={(i) => i.id}
          className="mt-6"
          contentContainerClassName="px-6 pb-6"
          ItemSeparatorComponent={() => <View className="h-px bg-ink/10" />}
          renderItem={({ item }) => (
            <View className="flex-row items-center gap-3 bg-cream-warm px-5 py-4">
              <Pressable
                onPress={() => router.push(`/more/items/${item.id}`)}
                className="flex-1 active:opacity-70"
              >
                <View className="flex-row items-center gap-2">
                  <Text className="font-serif text-lg text-ink">{item.name}</Text>
                  {item.archivedAt ? (
                    <Text className="rounded-sm border border-ink/15 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-widest text-ink/50">
                      Archived
                    </Text>
                  ) : null}
                </View>
                <Text className="mt-1 font-mono text-xs uppercase tracking-widest text-ink/50">
                  {priceLabel(item.unitPrice, item.unitLabel)}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => toggleArchive(item)}
                disabled={busyId === item.id}
                className="rounded-sm border border-ink/15 px-2 py-1 active:border-gold-deep disabled:opacity-50"
              >
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
                  {item.archivedAt ? 'Restore' : 'Archive'}
                </Text>
              </Pressable>
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}
