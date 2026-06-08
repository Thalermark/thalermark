import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../../lib/api';

// Recurring schedules list. Lives in the invoices Stack (reached via the
// "Recurring schedules →" link on the invoices list), not its own tab. Mirror
// of apps/web's /recurring. Rows join the customer name client-side.
type RecurringRow = {
  id: string;
  customerId: string;
  status: string;
  frequency: string;
  intervalCount: number;
  nextRunDate: string;
  currency: string;
  total: string;
};
type ListState =
  | { state: 'loading' }
  | { state: 'ready'; rows: RecurringRow[]; names: Record<string, string> }
  | { state: 'error' };

function cadenceLabel(frequency: string, interval: number): string {
  const unit = frequency === 'weekly' ? 'week' : frequency === 'monthly' ? 'month' : 'year';
  return interval === 1 ? `Every ${unit}` : `Every ${interval} ${unit}s`;
}

export default function RecurringList() {
  const router = useRouter();
  const [list, setList] = useState<ListState>({ state: 'loading' });

  useFocusEffect(
    useCallback(() => {
      let active = true;
      Promise.all([api.api['recurring-invoices'].$get(), api.api.customers.$get()])
        .then(async ([recRes, custRes]) => {
          if (!active) return;
          if (!recRes.ok) {
            setList({ state: 'error' });
            return;
          }
          const { recurringInvoices } = await recRes.json();
          const names: Record<string, string> = {};
          if (custRes.ok) {
            const { customers } = await custRes.json();
            for (const c of customers) names[c.id] = c.name;
          }
          setList({
            state: 'ready',
            rows: recurringInvoices.map((r) => ({
              id: r.id,
              customerId: r.customerId,
              status: r.status,
              frequency: r.frequency,
              intervalCount: r.intervalCount,
              nextRunDate: r.nextRunDate,
              currency: r.currency,
              total: r.total,
            })),
            names,
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
      <View className="px-6 pt-6">
        <Text
          onPress={() => router.push('/invoices')}
          className="font-mono text-xs uppercase tracking-widest text-ink/60"
        >
          ← Invoices
        </Text>
        <View className="mt-2 flex-row items-end justify-between">
          <Text className="font-serif text-3xl font-light text-ink">Recurring</Text>
          <Pressable
            onPress={() => router.push('/invoices/recurring/new')}
            className="rounded-sm bg-ink px-4 py-2 active:bg-gold-deep"
          >
            <Text className="text-sm font-medium text-cream">+ New</Text>
          </Pressable>
        </View>
      </View>

      {list.state === 'loading' ? (
        <View className="mt-12 items-center">
          <ActivityIndicator color="#0f1626" />
        </View>
      ) : list.state === 'error' ? (
        <Text className="mt-8 px-6 text-sm text-oxblood">Couldn't load schedules.</Text>
      ) : list.rows.length === 0 ? (
        <Text className="mt-8 px-6 text-ink/70">No recurring schedules yet.</Text>
      ) : (
        <FlatList
          data={list.rows}
          keyExtractor={(r) => r.id}
          className="mt-6"
          contentContainerClassName="px-6 pb-6"
          ItemSeparatorComponent={() => <View className="h-px bg-ink/10" />}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push(`/invoices/recurring/${item.id}`)}
              className="bg-cream-warm px-5 py-4 active:bg-cream"
            >
              <View className="flex-row items-center justify-between">
                <Text className="font-serif text-lg text-ink">
                  {list.names[item.customerId] ?? '—'}
                </Text>
                <Text className="font-mono tabular-nums text-ink">
                  {item.currency} {item.total}
                </Text>
              </View>
              <View className="mt-1 flex-row items-center justify-between">
                <Text className="text-sm text-ink/70">
                  {cadenceLabel(item.frequency, item.intervalCount)}
                </Text>
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                  {item.status}
                  {item.status !== 'ended' ? ` · next ${item.nextRunDate}` : ''}
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}
