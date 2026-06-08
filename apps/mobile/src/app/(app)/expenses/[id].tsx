import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';

// Read-only expense detail (mirror of the basic half of apps/web's
// /expenses/[id]). Category / payment are COA account UUIDs on the row; we
// fetch the company's accounts to resolve their names. Edit / delete /
// receipt are deferred to later slices.
type Expense = {
  merchant: string;
  amount: string;
  expenseDate: string;
  memo: string | null;
  categoryAccountId: string;
  paymentAccountId: string;
};
type DetailState =
  | { state: 'loading' }
  | { state: 'ready'; expense: Expense; categoryName: string | null; paymentName: string | null }
  | { state: 'error' };

export default function ExpenseDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [detail, setDetail] = useState<DetailState>({ state: 'loading' });

  useFocusEffect(
    useCallback(() => {
      let active = true;
      api.api.expenses[':id']
        .$get({ param: { id } })
        .then(async (res) => {
          if (!active) return;
          if (!res.ok) {
            setDetail({ state: 'error' });
            return;
          }
          const e = await res.json();
          let categoryName: string | null = null;
          let paymentName: string | null = null;
          const accRes = await api.api.companies[':id'].accounts.$get({
            param: { id: e.companyId },
            query: { type: undefined },
          });
          if (active && accRes.ok) {
            const { accounts } = await accRes.json();
            categoryName = accounts.find((a) => a.id === e.categoryAccountId)?.name ?? null;
            paymentName = accounts.find((a) => a.id === e.paymentAccountId)?.name ?? null;
          }
          if (!active) return;
          setDetail({
            state: 'ready',
            categoryName,
            paymentName,
            expense: {
              merchant: e.merchant,
              amount: e.amount,
              expenseDate: e.expenseDate,
              memo: e.memo ?? null,
              categoryAccountId: e.categoryAccountId,
              paymentAccountId: e.paymentAccountId,
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

  const e = detail.state === 'ready' ? detail.expense : null;

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Text
          onPress={() => router.push('/expenses')}
          className="font-mono text-xs uppercase tracking-widest text-ink/60"
        >
          ← Expenses
        </Text>

        {detail.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        ) : detail.state === 'error' || !e ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load this expense.</Text>
        ) : (
          <>
            <Text className="mt-3 font-serif text-3xl font-light text-ink">{e.merchant}</Text>
            <Text className="mt-1 font-mono text-2xl tabular-nums text-ink">{e.amount}</Text>

            <View className="mt-8 space-y-3">
              <Row label="Date" value={e.expenseDate} />
              <Row label="Category" value={detail.categoryName ?? '—'} />
              <Row label="Paid with" value={detail.paymentName ?? '—'} />
              {e.memo ? <Row label="Memo" value={e.memo} /> : null}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between">
      <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">{label}</Text>
      <Text className="text-ink">{value}</Text>
    </View>
  );
}
