import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { pickActiveCompany } from '../../../lib/active-company';
import { api } from '../../../lib/api';
import { billsApi } from '../../../lib/bills-api';

// AP aging — open bills bucketed by how far past due they are (the payable
// mirror of the A/R aging report). Mirror of apps/web's /bills/aging. The report
// is company-scoped (the API requires companyId), so it resolves the active
// company first.
type Bucket = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus';
type Aging = {
  asOf: string;
  buckets: Record<Bucket, string>;
  total: string;
  bills: {
    id: string;
    vendorName: string;
    reference: string | null;
    dueDate: string;
    amount: string;
    daysOverdue: number;
    bucket: string;
  }[];
};
type ViewState = { state: 'loading' } | { state: 'ready'; aging: Aging } | { state: 'error' };

const BUCKETS: { key: Bucket; label: string }[] = [
  { key: 'current', label: 'Current' },
  { key: 'd1_30', label: '1–30 days' },
  { key: 'd31_60', label: '31–60 days' },
  { key: 'd61_90', label: '61–90 days' },
  { key: 'd90_plus', label: '90+ days' },
];

const BUCKET_LABEL: Record<string, string> = {
  current: 'Current',
  d1_30: '1–30',
  d31_60: '31–60',
  d61_90: '61–90',
  d90_plus: '90+',
};

const fmt = (s: string) =>
  Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export default function BillsAging() {
  const router = useRouter();
  const [view, setView] = useState<ViewState>({ state: 'loading' });

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        const compRes = await api.api.companies.$get();
        if (!active) return;
        if (!compRes.ok) {
          setView({ state: 'error' });
          return;
        }
        const { companies } = await compRes.json();
        const company = await pickActiveCompany(companies);
        if (!company) {
          setView({ state: 'error' });
          return;
        }
        const res = await billsApi.api.bills.aging.$get({ query: { companyId: company.id } });
        if (!active) return;
        if (!res.ok) {
          setView({ state: 'error' });
          return;
        }
        setView({ state: 'ready', aging: (await res.json()) as Aging });
      })().catch(() => {
        if (active) setView({ state: 'error' });
      });
      return () => {
        active = false;
      };
    }, []),
  );

  const aging = view.state === 'ready' ? view.aging : null;

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Pressable onPress={() => router.push('/bills')}>
          <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">← Bills</Text>
        </Pressable>

        <View className="mt-3 flex-row items-end justify-between">
          <Text className="font-serif text-3xl font-light text-ink">AP aging</Text>
          {aging ? (
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
              as of {aging.asOf}
            </Text>
          ) : null}
        </View>

        {view.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        ) : view.state === 'error' || !aging ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load the aging report.</Text>
        ) : (
          <>
            <View className="mt-8 space-y-3">
              {BUCKETS.map((b) => (
                <View
                  key={b.key}
                  className="flex-row items-center justify-between rounded-sm border border-ink/10 bg-cream-warm px-4 py-3"
                >
                  <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                    {b.label}
                  </Text>
                  <Text className="font-serif text-lg font-light tabular-nums text-ink">
                    {fmt(aging.buckets[b.key])}
                  </Text>
                </View>
              ))}
              <View className="flex-row items-center justify-between rounded-sm border border-gold-deep/30 bg-gold-deep/5 px-4 py-3">
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
                  Total
                </Text>
                <Text className="font-serif text-lg font-light tabular-nums text-ink">
                  {fmt(aging.total)}
                </Text>
              </View>
            </View>

            {aging.bills.length === 0 ? (
              <Text className="mt-8 text-ink/70">No open bills — nothing outstanding.</Text>
            ) : (
              <View className="mt-8 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
                {aging.bills.map((b) => (
                  <Pressable
                    key={b.id}
                    onPress={() => router.push(`/bills/${b.id}`)}
                    className="border-b border-ink/10 px-4 py-3 active:bg-cream"
                  >
                    <View className="flex-row items-center justify-between">
                      <Text className="flex-1 pr-3 font-serif text-ink" numberOfLines={1}>
                        {b.vendorName}
                        {b.reference ? (
                          <Text className="font-mono text-xs text-ink/40"> #{b.reference}</Text>
                        ) : null}
                      </Text>
                      <Text className="font-mono tabular-nums text-ink">{fmt(b.amount)}</Text>
                    </View>
                    <Text className="mt-1 font-mono text-xs uppercase tracking-widest text-ink/50">
                      due {b.dueDate} · {BUCKET_LABEL[b.bucket] ?? b.bucket}
                      {b.daysOverdue > 0 ? ` · ${b.daysOverdue}d` : ''}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
