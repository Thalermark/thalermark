import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';

// Mirror of the basic-fields half of apps/web's /customers/[id]. Read-only for
// M2 — edit, payment-reliability, and audit history are later mobile slices.
type Customer = {
  name: string;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  notes: string | null;
};
type DetailState =
  | { state: 'loading' }
  | { state: 'ready'; customer: Customer }
  | { state: 'error' };

export default function CustomerDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [detail, setDetail] = useState<DetailState>({ state: 'loading' });

  useFocusEffect(
    useCallback(() => {
      let active = true;
      api.api.customers[':id']
        .$get({ param: { id } })
        .then(async (res) => {
          if (!active) return;
          if (!res.ok) {
            setDetail({ state: 'error' });
            return;
          }
          const c = await res.json();
          setDetail({
            state: 'ready',
            customer: {
              name: c.name,
              email: c.email ?? null,
              phone: c.phone ?? null,
              addressLine1: c.addressLine1 ?? null,
              addressLine2: c.addressLine2 ?? null,
              city: c.city ?? null,
              region: c.region ?? null,
              postalCode: c.postalCode ?? null,
              country: c.country ?? null,
              notes: c.notes ?? null,
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

  const c = detail.state === 'ready' ? detail.customer : null;
  const addressLines = c
    ? [
        c.addressLine1,
        c.addressLine2,
        [c.city, c.region, c.postalCode].filter(Boolean).join(', ') || null,
        c.country,
      ].filter((line): line is string => Boolean(line))
    : [];

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Text
          onPress={() => router.push('/customers')}
          className="font-mono text-xs uppercase tracking-widest text-ink/60"
        >
          ← Customers
        </Text>

        {detail.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        ) : detail.state === 'error' || !c ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load this customer.</Text>
        ) : (
          <>
            <Text className="mt-3 font-serif text-3xl font-light text-ink">{c.name}</Text>
            <View className="mt-8 space-y-6">
              {c.email ? <DetailRow label="Email" value={c.email} /> : null}
              {c.phone ? <DetailRow label="Phone" value={c.phone} /> : null}
              {addressLines.length > 0 ? (
                <View>
                  <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                    Address
                  </Text>
                  {addressLines.map((line) => (
                    <Text key={line} className="mt-1 text-ink">
                      {line}
                    </Text>
                  ))}
                </View>
              ) : null}
              {c.notes ? <DetailRow label="Notes" value={c.notes} /> : null}
            </View>
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
