import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type AuditEvent, AuditHistory } from '../../../../components/AuditHistory';
import { api } from '../../../../lib/api';
import { useMay } from '../../../../lib/role';

// Owner money event detail — mirror of apps/web's /owner-money/[id]. A plain
// record of money the owner put in / took out. Edit reverses + reposts; delete
// is soft (sets deleted_at + posts a reversal). expenses:write gates both.
type Event = {
  kind: string;
  amount: string;
  occurredOn: string;
  memo: string | null;
};
type DetailState = { state: 'loading' } | { state: 'ready'; event: Event } | { state: 'error' };

const fmt = (s: string) =>
  Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export default function OwnerMoneyDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [detail, setDetail] = useState<DetailState>({ state: 'loading' });
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    const res = await api.api['owner-money'][':id'].$get({ param: { id } });
    if (!res.ok) {
      setDetail({ state: 'error' });
      return;
    }
    const e = await res.json();
    setDetail({
      state: 'ready',
      event: {
        kind: e.kind,
        amount: e.amount,
        occurredOn: e.occurredOn,
        memo: e.memo ?? null,
      },
    });
    try {
      const auditRes = await api.api['audit-events'].$get({
        query: { entityType: 'owner_money_event', entityId: id },
      });
      if (auditRes.ok) setAuditEvents((await auditRes.json()).events);
    } catch {}
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      load().catch(() => {
        if (active) setDetail({ state: 'error' });
      });
      return () => {
        active = false;
      };
    }, [load]),
  );

  // Role gate (UX only — the API is authoritative). Edit/delete = expenses:write.
  const canWrite = useMay('expenses:write');
  const event = detail.state === 'ready' ? detail.event : null;
  const isIn = event?.kind === 'contribution';

  function onDelete() {
    Alert.alert('Delete this?', 'This reverses its ledger entry and cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          setActing(true);
          try {
            const res = await api.api['owner-money'][':id'].$delete({ param: { id } });
            if (res.ok) router.replace('/owner-money');
          } finally {
            setActing(false);
          }
        },
      },
    ]);
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Text
          onPress={() => router.push('/owner-money')}
          className="font-mono text-xs uppercase tracking-widest text-ink/60"
        >
          ← Investments
        </Text>

        {detail.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        ) : detail.state === 'error' || !event ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load this.</Text>
        ) : (
          <>
            <View className="mt-3 flex-row items-start justify-between gap-3">
              <View className="flex-1">
                <Text className="font-serif text-3xl font-light text-ink">
                  {isIn ? 'Investment' : 'Withdrawal'}
                </Text>
                <Text
                  className={`mt-1 font-mono text-2xl tabular-nums ${isIn ? 'text-gold-deep' : 'text-ink'}`}
                >
                  {isIn ? '+' : '−'}
                  {fmt(event.amount)}
                </Text>
              </View>
            </View>

            {canWrite ? (
              <View className="mt-6 flex-row gap-2">
                <Pressable
                  onPress={() => router.push(`/owner-money/${id}/edit`)}
                  disabled={acting}
                  className="rounded-sm border border-ink/20 px-4 py-3 active:bg-ink/5 disabled:opacity-50"
                >
                  <Text className="font-mono text-xs uppercase tracking-widest text-ink/70">
                    Edit
                  </Text>
                </Pressable>
                <Pressable
                  onPress={onDelete}
                  disabled={acting}
                  className="rounded-sm border border-oxblood/30 px-4 py-3 active:bg-oxblood/5 disabled:opacity-50"
                >
                  <Text className="font-mono text-xs uppercase tracking-widest text-oxblood">
                    Delete
                  </Text>
                </Pressable>
              </View>
            ) : null}

            <View className="mt-8 space-y-3">
              <Row label="Type" value={isIn ? 'You put money in' : 'You took money out'} />
              <Row label="Date" value={event.occurredOn} />
              {event.memo ? <Row label="Note" value={event.memo} /> : null}
            </View>

            <AuditHistory events={auditEvents} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between gap-4">
      <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">{label}</Text>
      <Text className="flex-1 text-right text-ink">{value}</Text>
    </View>
  );
}
