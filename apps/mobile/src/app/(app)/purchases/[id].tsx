import { loanPaymentSchema } from '@thalermark/validation';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type AuditEvent, AuditHistory } from '../../../components/AuditHistory';
import { api } from '../../../lib/api';
import { useMay } from '../../../lib/role';

// Mirror of apps/web's /purchases/[id]. The plain answer up top ("you still owe
// $X"), the tax answer, a record-a-payment form while a balance remains, and a
// remove action. Accounting stays hidden.
type Purchase = {
  description: string;
  amount: string;
  purchaseDate: string;
  funding: string;
  owing: string;
  vendorName: string | null;
  schedule: { perYear: string; years: number } | null;
};
type DetailState =
  | { state: 'loading' }
  | { state: 'ready'; purchase: Purchase }
  | { state: 'error' };

const todayIso = () => new Date().toISOString().slice(0, 10);
const money = (s: string) =>
  Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export default function PurchaseDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [detail, setDetail] = useState<DetailState>({ state: 'loading' });
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [acting, setActing] = useState(false);

  // Record-a-payment form.
  const [payAmount, setPayAmount] = useState('');
  const [payInterest, setPayInterest] = useState('');
  const [payDate, setPayDate] = useState(todayIso());
  const [payError, setPayError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api.api.purchases[':id'].$get({ param: { id } });
    if (!res.ok) {
      setDetail({ state: 'error' });
      return;
    }
    const p = await res.json();
    setDetail({
      state: 'ready',
      purchase: {
        description: p.description,
        amount: p.amount,
        purchaseDate: p.purchaseDate,
        funding: p.funding,
        owing: p.owing,
        vendorName: p.vendorName ?? null,
        schedule: p.schedule,
      },
    });
    try {
      const auditRes = await api.api['audit-events'].$get({
        query: { entityType: 'capital_purchase', entityId: id },
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

  const canWrite = useMay('expenses:write');
  const purchase = detail.state === 'ready' ? detail.purchase : null;
  const financed = purchase?.funding === 'financed';
  const stillOwes = purchase ? Number(purchase.owing) > 0 : false;

  async function onRecordPayment() {
    setPayError(null);
    const parsed = loanPaymentSchema.safeParse({
      amount: payAmount.trim(),
      interest: payInterest.trim() === '' ? undefined : payInterest.trim(),
      paidOn: payDate.trim(),
    });
    if (!parsed.success) {
      setPayError(parsed.error.issues[0]?.message ?? 'Invalid payment.');
      return;
    }
    setActing(true);
    try {
      const res = await api.api.purchases[':id'].payments.$post({
        param: { id },
        json: parsed.data,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setPayError(
          body?.error === 'payment_exceeds_balance'
            ? "That's more than you still owe."
            : (body?.error ?? 'Could not record the payment.'),
        );
        return;
      }
      setPayAmount('');
      setPayInterest('');
      await load();
    } finally {
      setActing(false);
    }
  }

  function onRemove() {
    Alert.alert('Remove this purchase?', 'This removes it from your books.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          setActing(true);
          try {
            const res = await api.api.purchases[':id'].$delete({ param: { id } });
            if (res.ok) {
              router.replace('/purchases');
            } else {
              const body = (await res.json().catch(() => null)) as { error?: string } | null;
              Alert.alert(
                'Could not remove',
                body?.error === 'has_payments'
                  ? "You've already recorded payments on this, so it can't be removed."
                  : 'Please try again.',
              );
            }
          } finally {
            setActing(false);
          }
        },
      },
    ]);
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16" keyboardShouldPersistTaps="handled">
        <Text
          onPress={() => router.push('/purchases')}
          className="font-mono text-xs uppercase tracking-widest text-ink/60"
        >
          ← Big purchases
        </Text>

        {detail.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        ) : detail.state === 'error' || !purchase ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load this.</Text>
        ) : (
          <>
            <Text className="mt-3 font-serif text-3xl font-light text-ink">
              {purchase.description}
            </Text>

            {financed ? (
              <View className="mt-6 rounded-sm border border-ink/10 bg-cream-warm px-5 py-4">
                {stillOwes ? (
                  <>
                    <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                      You still owe
                    </Text>
                    <Text className="mt-1 font-mono text-2xl tabular-nums text-ink">
                      {money(purchase.owing)}
                    </Text>
                  </>
                ) : (
                  <Text className="font-serif text-ink">
                    Paid off — you don't owe anything more on this.
                  </Text>
                )}
              </View>
            ) : null}

            <View className="mt-8 space-y-3">
              <Row label="Cost" value={money(purchase.amount)} />
              <Row label="Bought" value={purchase.purchaseDate} />
              {purchase.vendorName ? <Row label="From" value={purchase.vendorName} /> : null}
              <Row
                label="On taxes"
                value={
                  purchase.schedule
                    ? `Spread out — about ${money(purchase.schedule.perYear)} a year for ${purchase.schedule.years} years.`
                    : 'Deducted in full the year you bought it.'
                }
              />
            </View>

            {canWrite && financed && stillOwes ? (
              <View className="mt-8 rounded-sm border border-ink/10 bg-cream-warm p-5">
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                  Record a payment
                </Text>
                {payError ? <Text className="mt-2 text-xs text-oxblood">{payError}</Text> : null}
                <View className="mt-3 space-y-3">
                  <PayField label="Amount paid *" value={payAmount} onChangeText={setPayAmount} />
                  <PayField
                    label="Of that, interest (optional)"
                    value={payInterest}
                    onChangeText={setPayInterest}
                  />
                  <PayField label="Date *" value={payDate} onChangeText={setPayDate} />
                  <Pressable
                    onPress={onRecordPayment}
                    disabled={acting}
                    className="mt-1 rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
                  >
                    {acting ? (
                      <ActivityIndicator color="#f4ede0" />
                    ) : (
                      <Text className="text-center text-sm font-medium text-cream">
                        Record payment
                      </Text>
                    )}
                  </Pressable>
                </View>
              </View>
            ) : null}

            {canWrite ? (
              <Pressable
                onPress={onRemove}
                disabled={acting}
                className="mt-8 self-start rounded-sm border border-oxblood/30 px-4 py-3 active:bg-oxblood/5 disabled:opacity-50"
              >
                <Text className="font-mono text-xs uppercase tracking-widest text-oxblood">
                  Remove this purchase
                </Text>
              </Pressable>
            ) : null}

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

function PayField({
  label,
  value,
  onChangeText,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
}) {
  const isDate = label.startsWith('Date');
  return (
    <View>
      <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType={isDate ? undefined : 'decimal-pad'}
        placeholder={isDate ? 'YYYY-MM-DD' : '0.00'}
        autoCapitalize="none"
        className="mt-1 rounded-sm border border-ink/15 bg-cream px-3 py-2 text-ink"
      />
    </View>
  );
}
