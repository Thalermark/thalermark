import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type AuditEvent, AuditHistory } from '../../../../../components/AuditHistory';
import { api } from '../../../../../lib/api';
import { useMay } from '../../../../../lib/role';

// Mirror of apps/web's /settings/items/[id]. Edit + archive/restore + the
// per-entity audit trail (M11e); sales history is kept either way (archive
// just hides the item from the picker).
type Item = {
  name: string;
  description: string | null;
  unitPrice: string;
  unitLabel: string | null;
  defaultQuantity: string;
  archivedAt: string | null;
};
type DetailState = { state: 'loading' } | { state: 'ready'; item: Item } | { state: 'error' };

const fmt = (s: string) =>
  Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
// Trailing zeros from numeric(15,4) read oddly for a quantity ("2.5000").
const qty = (s: string) => String(Number(s));

export default function ItemDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [detail, setDetail] = useState<DetailState>({ state: 'loading' });
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    (active: () => boolean) => {
      api.api.items[':id']
        .$get({ param: { id } })
        .then(async (res) => {
          if (!active()) return;
          if (!res.ok) {
            setDetail({ state: 'error' });
            return;
          }
          const i = await res.json();
          setDetail({
            state: 'ready',
            item: {
              name: i.name,
              description: i.description ?? null,
              unitPrice: i.unitPrice,
              unitLabel: i.unitLabel ?? null,
              defaultQuantity: i.defaultQuantity,
              archivedAt: i.archivedAt ?? null,
            },
          });
        })
        .catch(() => {
          if (active()) setDetail({ state: 'error' });
        });
      // Audit trail — best-effort sidebar; refetched on every load() (focus +
      // after archive/restore), and a non-OK response degrades to empty.
      api.api['audit-events']
        .$get({ query: { entityType: 'item', entityId: id } })
        .then(async (res) => {
          if (active() && res.ok) setAuditEvents((await res.json()).events);
        })
        .catch(() => {});
    },
    [id],
  );

  // Refetch on focus so an edit on the child screen shows on return.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      load(() => alive);
      return () => {
        alive = false;
      };
    }, [load]),
  );

  // Role gate (UX only — the API is authoritative). The catalog feeds
  // invoicing, so edit/archive are `sales:write`.
  const canWrite = useMay('sales:write');
  const item = detail.state === 'ready' ? detail.item : null;
  const archived = item?.archivedAt != null;

  async function toggleArchive() {
    if (!item) return;
    setBusy(true);
    try {
      const res = archived
        ? await api.api.items[':id'].restore.$post({ param: { id } })
        : await api.api.items[':id'].archive.$post({ param: { id } });
      if (res.ok) load(() => true);
    } catch {
      // A focus refetch will reconcile.
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Pressable onPress={() => router.push('/more/items')}>
          <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">← Items</Text>
        </Pressable>

        {detail.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        ) : detail.state === 'error' || !item ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load this item.</Text>
        ) : (
          <>
            <View className="mt-3 flex-row items-start justify-between gap-3">
              <View className="flex-1 flex-row flex-wrap items-center gap-2">
                <Text className="font-serif text-3xl font-light text-ink">{item.name}</Text>
                {archived ? (
                  <Text className="rounded-sm border border-ink/15 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-widest text-ink/50">
                    Archived
                  </Text>
                ) : null}
              </View>
            </View>

            {canWrite ? (
              <View className="mt-4 flex-row gap-2">
                <Pressable
                  onPress={() => router.push(`/more/items/${id}/edit`)}
                  className="rounded-sm border border-ink/20 px-3 py-1.5 active:border-gold-deep"
                >
                  <Text className="font-mono text-xs uppercase tracking-widest text-ink/70">
                    Edit
                  </Text>
                </Pressable>
                <Pressable
                  onPress={toggleArchive}
                  disabled={busy}
                  className="rounded-sm border border-ink/20 px-3 py-1.5 active:border-gold-deep disabled:opacity-50"
                >
                  <Text className="font-mono text-xs uppercase tracking-widest text-ink/70">
                    {archived ? 'Restore' : 'Archive'}
                  </Text>
                </Pressable>
              </View>
            ) : null}

            {archived ? (
              <Text className="mt-6 rounded-sm border border-ink/15 bg-cream-warm px-4 py-3 text-sm text-ink/70">
                This item is archived — it won't appear in the line-item picker. Its sales history
                is kept.
              </Text>
            ) : null}

            <View className="mt-8 space-y-6">
              <DetailRow
                label="Unit price"
                value={
                  item.unitLabel
                    ? `${fmt(item.unitPrice)} / ${item.unitLabel}`
                    : fmt(item.unitPrice)
                }
              />
              <DetailRow label="Default quantity" value={qty(item.defaultQuantity)} />
              {item.description ? <DetailRow label="Description" value={item.description} /> : null}
            </View>

            <AuditHistory events={auditEvents} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">{label}</Text>
      <Text className="mt-1 text-ink">{value}</Text>
    </View>
  );
}
