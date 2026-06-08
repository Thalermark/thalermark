import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';

// Read-only invoice detail (mirror of the basic half of apps/web's
// /invoices/[id]). Status actions / send / edit are deferred to later slices.
type LineItem = {
  position: number;
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
};
type Invoice = {
  number: string;
  status: string;
  customerId: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  subtotal: string;
  tax: string | null;
  total: string;
  notes: string | null;
  lineItems: LineItem[];
};
type DetailState =
  | { state: 'loading' }
  | { state: 'ready'; invoice: Invoice; customerName: string | null }
  | { state: 'error' };

export default function InvoiceDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [detail, setDetail] = useState<DetailState>({ state: 'loading' });

  useFocusEffect(
    useCallback(() => {
      let active = true;
      api.api.invoices[':id']
        .$get({ param: { id } })
        .then(async (res) => {
          if (!active) return;
          if (!res.ok) {
            setDetail({ state: 'error' });
            return;
          }
          const inv = await res.json();
          let customerName: string | null = null;
          const custRes = await api.api.customers[':id'].$get({ param: { id: inv.customerId } });
          if (active && custRes.ok) customerName = (await custRes.json()).name;
          if (!active) return;
          setDetail({
            state: 'ready',
            customerName,
            invoice: {
              number: inv.number,
              status: inv.status,
              customerId: inv.customerId,
              issueDate: inv.issueDate,
              dueDate: inv.dueDate,
              currency: inv.currency,
              subtotal: inv.subtotal,
              tax: inv.tax ?? null,
              total: inv.total,
              notes: inv.notes ?? null,
              lineItems: inv.lineItems,
            },
          });
        })
        .catch(() => {
          if (active) setDetail({ state: 'error' });
        });
      return () => {
        active = false;
      };
    }, [id]),
  );

  const inv = detail.state === 'ready' ? detail.invoice : null;

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Text
          onPress={() => router.push('/invoices')}
          className="font-mono text-xs uppercase tracking-widest text-ink/60"
        >
          ← Invoices
        </Text>

        {detail.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        ) : detail.state === 'error' || !inv ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load this invoice.</Text>
        ) : (
          <>
            <View className="mt-3 flex-row items-center justify-between">
              <Text className="font-serif text-3xl font-light text-ink">{inv.number}</Text>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
                {inv.status}
              </Text>
            </View>

            <View className="mt-6 space-y-2">
              <Meta label="Customer" value={detail.customerName ?? '—'} />
              <Meta label="Issued" value={inv.issueDate} />
              <Meta label="Due" value={inv.dueDate} />
            </View>

            <View className="mt-8 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
              {inv.lineItems.map((li) => (
                <View key={li.position} className="border-b border-ink/10 px-4 py-3">
                  <Text className="text-ink">{li.description}</Text>
                  <View className="mt-1 flex-row justify-between">
                    <Text className="font-mono text-xs text-ink/50">
                      {String(Number(li.quantity))} × {li.unitPrice}
                    </Text>
                    <Text className="font-mono tabular-nums text-ink">{li.amount}</Text>
                  </View>
                </View>
              ))}
              <View className="px-4 py-3">
                <Meta label="Subtotal" value={inv.subtotal} mono />
                <View className="mt-1">
                  <Meta label="Tax" value={inv.tax ?? '0.00'} mono />
                </View>
                <View className="mt-2 border-t border-ink/10 pt-2">
                  <Meta label="Total" value={`${inv.currency} ${inv.total}`} mono emphasize />
                </View>
              </View>
            </View>

            {inv.notes ? (
              <View className="mt-6">
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                  Notes
                </Text>
                <Text className="mt-1 text-ink/80">{inv.notes}</Text>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Meta({
  label,
  value,
  mono,
  emphasize,
}: {
  label: string;
  value: string;
  mono?: boolean;
  emphasize?: boolean;
}) {
  return (
    <View className="flex-row justify-between">
      <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">{label}</Text>
      <Text
        className={`text-ink ${mono ? 'font-mono tabular-nums' : ''} ${emphasize ? 'text-lg' : ''}`}
      >
        {value}
      </Text>
    </View>
  );
}
