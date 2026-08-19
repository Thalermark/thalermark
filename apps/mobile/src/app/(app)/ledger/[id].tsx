import { sumMoney } from '@thalermark/validation';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type AuditEvent, AuditHistory } from '../../../components/AuditHistory';
import { api } from '../../../lib/api';
import { useMay } from '../../../lib/role';

// Mirror of apps/web's /ledger/[id]. A manual journal entry shown as a classic
// Account / Debit / Credit table. Append-only — the only "undo" is Reverse,
// which posts the opposite entry. ledger:adjust gates Reverse.
type Line = {
  coaAccountId: string;
  code: string;
  accountName: string;
  side: 'debit' | 'credit';
  amount: string;
};
type Entry = { postedAt: string; memo: string | null; lines: Line[]; reversed: boolean };
type DetailState = { state: 'loading' } | { state: 'ready'; entry: Entry } | { state: 'error' };

export default function LedgerEntryDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [detail, setDetail] = useState<DetailState>({ state: 'loading' });
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    const res = await api.api.ledger.entries[':id'].$get({ param: { id } });
    if (!res.ok) {
      setDetail({ state: 'error' });
      return;
    }
    const e = await res.json();
    setDetail({
      state: 'ready',
      entry: {
        postedAt: e.postedAt,
        memo: e.memo ?? null,
        reversed: e.reversed,
        lines: e.lines.map(
          (l): Line => ({
            coaAccountId: l.coaAccountId,
            code: l.code,
            accountName: l.accountName,
            side: l.side,
            amount: l.amount,
          }),
        ),
      },
    });
    try {
      const auditRes = await api.api['audit-events'].$get({
        query: { entityType: 'manual_adjustment', entityId: id },
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

  const entry = detail.state === 'ready' ? detail.entry : null;
  const canReverse = useMay('ledger:adjust') && entry !== null && !entry.reversed;
  const totalDebit = entry
    ? sumMoney(entry.lines.filter((l) => l.side === 'debit').map((l) => l.amount))
    : '0.00';
  const totalCredit = entry
    ? sumMoney(entry.lines.filter((l) => l.side === 'credit').map((l) => l.amount))
    : '0.00';

  function onReverse() {
    Alert.alert('Reverse this entry?', 'This posts an opposite entry and cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reverse',
        style: 'destructive',
        onPress: async () => {
          setActing(true);
          try {
            const res = await api.api.ledger.entries[':id'].reverse.$post({ param: { id } });
            if (res.ok) await load();
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
          onPress={() => router.push('/ledger')}
          className="font-mono text-xs uppercase tracking-widest text-ink-subtle"
        >
          ← The Ledger
        </Text>

        {detail.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator className="text-ink" />
          </View>
        ) : detail.state === 'error' || !entry ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load this.</Text>
        ) : (
          <>
            <Text className="mt-3 font-serif text-3xl font-light text-ink">Journal entry</Text>

            {entry.reversed ? (
              <View className="mt-4 rounded-sm border border-ink/20 bg-cream-warm px-4 py-3">
                <Text className="text-sm text-ink-muted">
                  This entry has been reversed — a balancing opposite entry was posted, so it no
                  longer affects your books.
                </Text>
              </View>
            ) : null}

            {canReverse ? (
              <Pressable
                onPress={onReverse}
                disabled={acting}
                className="mt-6 self-start rounded-sm border border-oxblood/30 px-4 py-3 active:bg-oxblood/5 disabled:opacity-50"
              >
                <Text className="font-mono text-xs uppercase tracking-widest text-oxblood">
                  Reverse
                </Text>
              </Pressable>
            ) : null}

            <View className="mt-8 gap-3">
              <Row label="Date" value={entry.postedAt.slice(0, 10)} />
              <Row label="Description" value={entry.memo ?? '—'} />
            </View>

            <View className="mt-8 overflow-hidden rounded-sm border border-ink/10">
              <View className="flex-row border-b border-ink/10 bg-cream-warm px-4 py-2">
                <Text className="flex-1 font-mono text-xs uppercase tracking-widest text-ink-subtle">
                  Account
                </Text>
                <Text className="w-20 text-right font-mono text-xs uppercase tracking-widest text-ink-subtle">
                  Debit
                </Text>
                <Text className="w-20 text-right font-mono text-xs uppercase tracking-widest text-ink-subtle">
                  Credit
                </Text>
              </View>
              {entry.lines.map((l) => (
                <View
                  key={`${l.coaAccountId}-${l.side}-${l.amount}`}
                  className="flex-row items-center border-b border-ink/10 px-4 py-3"
                >
                  <Text className="flex-1 text-ink" numberOfLines={1}>
                    <Text className="font-mono text-ink-subtle">{l.code} </Text>
                    {l.accountName}
                  </Text>
                  <Text className="w-20 text-right font-mono tabular-nums text-ink">
                    {l.side === 'debit' ? l.amount : ''}
                  </Text>
                  <Text className="w-20 text-right font-mono tabular-nums text-ink">
                    {l.side === 'credit' ? l.amount : ''}
                  </Text>
                </View>
              ))}
              <View className="flex-row bg-cream-warm px-4 py-3">
                <Text className="flex-1 text-right font-mono text-xs uppercase tracking-widest text-ink-subtle">
                  Totals
                </Text>
                <Text className="w-20 text-right font-mono tabular-nums text-ink">
                  {totalDebit}
                </Text>
                <Text className="w-20 text-right font-mono tabular-nums text-ink">
                  {totalCredit}
                </Text>
              </View>
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
      <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">{label}</Text>
      <Text className="flex-1 text-right text-ink">{value}</Text>
    </View>
  );
}
