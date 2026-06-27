import { BILL_PAYMENT_METHODS, type BillPaymentMethod } from '@thalermark/validation';
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
import { type AuditEvent, AuditHistory } from '../../../../components/AuditHistory';
import { DateField } from '../../../../components/DateField';
import { api } from '../../../../lib/api';
import { billsApi } from '../../../../lib/bills-api';
import { useMay } from '../../../../lib/role';

// Bill (accounts payable) detail + status actions — mirror of apps/web's
// /bills/[id]. Open bills can be marked paid (Dr AP / Cr payment asset; the
// asset defaults to Cash server-side), edited, or voided (reverses the open
// posting). Paid/voided are terminal. Reuses the invoice mark-paid panel shape
// (method chips + conditional reference + a paidOn date). expenses:write gates
// every write — managing payables is the accountant's job.
type Bill = {
  companyId: string;
  vendorName: string;
  contactId: string;
  status: string;
  amount: string;
  categoryAccountId: string;
  paymentAccountId: string | null;
  billDate: string;
  dueDate: string;
  reference: string | null;
  memo: string | null;
  paymentMethod: string | null;
  paymentReference: string | null;
  paidAt: string | null;
};
type DetailState =
  | { state: 'loading' }
  | { state: 'ready'; bill: Bill; categoryName: string | null; paymentName: string | null }
  | { state: 'error' };

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  check: 'Check',
  venmo: 'Venmo',
  zelle: 'Zelle',
  other: 'Other',
};

const TRANSITION_ERRORS: Record<string, string> = {
  invalid_transition: 'This bill can no longer be changed.',
  bill_not_editable: 'This bill can no longer be edited.',
};

const fmt = (s: string) =>
  Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const todayIso = () => new Date().toISOString().slice(0, 10);

export default function BillDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [detail, setDetail] = useState<DetailState>({ state: 'loading' });
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [acting, setActing] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);

  // Mark-paid panel state — mirrors the invoice detail panel.
  const [showPaidPanel, setShowPaidPanel] = useState(false);
  const [paidMethod, setPaidMethod] = useState<BillPaymentMethod>('cash');
  const [paidReference, setPaidReference] = useState('');
  const [paidOn, setPaidOn] = useState(todayIso());

  const load = useCallback(async () => {
    const res = await billsApi.api.bills[':id'].$get({ param: { id } });
    if (!res.ok) {
      setDetail({ state: 'error' });
      return;
    }
    const b = await res.json();
    // Resolve the category (+ payment, if paid) account ids to names. Best-effort
    // — a failed accounts fetch falls back to '—'.
    let categoryName: string | null = null;
    let paymentName: string | null = null;
    const accRes = await api.api.companies[':id'].accounts.$get({
      param: { id: b.companyId },
      query: { type: undefined },
    });
    if (accRes.ok) {
      const { accounts } = await accRes.json();
      categoryName = accounts.find((a) => a.id === b.categoryAccountId)?.name ?? null;
      paymentName = b.paymentAccountId
        ? (accounts.find((a) => a.id === b.paymentAccountId)?.name ?? null)
        : null;
    }
    setDetail({
      state: 'ready',
      categoryName,
      paymentName,
      bill: {
        companyId: b.companyId,
        vendorName: b.vendorName,
        contactId: b.contactId,
        status: b.status,
        amount: b.amount,
        categoryAccountId: b.categoryAccountId,
        paymentAccountId: b.paymentAccountId ?? null,
        billDate: b.billDate,
        dueDate: b.dueDate,
        reference: b.reference ?? null,
        memo: b.memo ?? null,
        paymentMethod: b.paymentMethod ?? null,
        paymentReference: b.paymentReference ?? null,
        paidAt: b.paidAt ?? null,
      },
    });
    // Audit trail — best-effort; refetched on every load() (focus + after each
    // in-screen transition), so the history reflects the action just taken. A
    // failure here must not flip the whole screen to error, hence the swallow.
    try {
      const auditRes = await api.api['audit-events'].$get({
        query: { entityType: 'bill', entityId: id },
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

  // Role gate (UX only — the API is authoritative). Every bill write is
  // `expenses:write`; each action is ANDed with the open state.
  const canWrite = useMay('expenses:write');
  const bill = detail.state === 'ready' ? detail.bill : null;
  const isOpen = bill?.status === 'open';
  const canAct = canWrite && isOpen;

  // Run a transition, then reload.
  async function act(
    fn: () => Promise<{ ok: boolean; json: () => Promise<unknown> }>,
    onOk?: () => void,
  ) {
    setActing(true);
    setTransitionError(null);
    try {
      const res = await fn();
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setTransitionError(TRANSITION_ERRORS[body?.error ?? ''] ?? body?.error ?? 'Action failed.');
        return;
      }
      onOk?.();
      await load();
    } catch {
      setTransitionError('Action failed.');
    } finally {
      setActing(false);
    }
  }

  function onMarkPaid() {
    const reference = paidReference.trim();
    act(
      () =>
        billsApi.api.bills[':id']['mark-paid'].$post({
          param: { id },
          json: { method: paidMethod, reference: reference || undefined, paidOn },
        }),
      () => setShowPaidPanel(false),
    );
  }

  function onVoid() {
    Alert.alert('Void bill?', 'This reverses its ledger entry and cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Void',
        style: 'destructive',
        onPress: () => act(() => billsApi.api.bills[':id'].void.$post({ param: { id } })),
      },
    ]);
  }

  const paidVia =
    bill?.status === 'paid' && bill.paymentMethod
      ? (PAYMENT_METHOD_LABELS[bill.paymentMethod] ?? bill.paymentMethod)
      : null;

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16" keyboardShouldPersistTaps="handled">
        <Text
          onPress={() => router.push('/bills')}
          className="font-mono text-xs uppercase tracking-widest text-ink/60"
        >
          ← Bills
        </Text>

        {detail.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        ) : detail.state === 'error' || !bill ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load this bill.</Text>
        ) : (
          <>
            <View className="mt-3 flex-row items-start justify-between gap-3">
              <View className="flex-1">
                <Text className="font-serif text-3xl font-light text-ink">{bill.vendorName}</Text>
                <Text className="mt-1 font-mono text-2xl tabular-nums text-ink">
                  {fmt(bill.amount)}
                </Text>
              </View>
              <Text className="mt-2 font-mono text-xs uppercase tracking-widest text-ink/60">
                {bill.status}
              </Text>
            </View>

            {transitionError ? (
              <View className="mt-4 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
                <Text className="text-sm text-oxblood">{transitionError}</Text>
              </View>
            ) : null}

            {/* Actions — open bills only */}
            {canAct ? (
              <View className="mt-6 space-y-3">
                <View className="flex-row gap-2">
                  <Pressable
                    onPress={() => setShowPaidPanel((v) => !v)}
                    disabled={acting}
                    className="flex-1 rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
                  >
                    <Text className="text-center text-sm font-medium text-cream">Mark paid</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => router.push(`/bills/${id}/edit`)}
                    disabled={acting}
                    className="rounded-sm border border-ink/20 px-4 py-3 active:bg-ink/5 disabled:opacity-50"
                  >
                    <Text className="font-mono text-xs uppercase tracking-widest text-ink/70">
                      Edit
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={onVoid}
                    disabled={acting}
                    className="rounded-sm border border-oxblood/30 px-4 py-3 active:bg-oxblood/5 disabled:opacity-50"
                  >
                    <Text className="font-mono text-xs uppercase tracking-widest text-oxblood">
                      Void
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : null}

            {/* Mark-paid panel */}
            {canAct && showPaidPanel ? (
              <View className="mt-4 rounded-sm border border-ink/15 bg-cream-warm p-4">
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                  How did you pay it?
                </Text>
                <View className="mt-3 flex-row flex-wrap gap-2">
                  {BILL_PAYMENT_METHODS.map((m) => (
                    <Pressable
                      key={m}
                      onPress={() => setPaidMethod(m)}
                      className={`rounded-sm border px-3 py-2 ${
                        paidMethod === m ? 'border-gold-deep bg-gold-deep/10' : 'border-ink/20'
                      }`}
                    >
                      <Text className={paidMethod === m ? 'text-ink' : 'text-ink/70'}>
                        {PAYMENT_METHOD_LABELS[m]}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                {paidMethod === 'check' || paidMethod === 'other' ? (
                  <View className="mt-3">
                    <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                      {paidMethod === 'check' ? 'Check number' : 'Note'}
                    </Text>
                    <TextInput
                      value={paidReference}
                      onChangeText={setPaidReference}
                      className="mt-1 rounded-sm border border-ink/15 bg-cream px-3 py-2 text-ink"
                    />
                  </View>
                ) : null}
                <View className="mt-3">
                  <DateField label="Payment date" value={paidOn} onChange={setPaidOn} />
                </View>
                <Pressable
                  onPress={onMarkPaid}
                  disabled={acting}
                  className="mt-4 rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
                >
                  <Text className="text-center text-sm font-medium text-cream">Record payment</Text>
                </Pressable>
              </View>
            ) : null}

            {/* Paid block */}
            {bill.status === 'paid' ? (
              <View className="mt-6 rounded-sm border border-gold-deep/30 bg-gold-deep/5 p-4">
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                  Paid
                </Text>
                <View className="mt-2 space-y-1">
                  {paidVia ? <Row label="Method" value={paidVia} /> : null}
                  {bill.paymentReference ? (
                    <Row label="Reference" value={bill.paymentReference} />
                  ) : null}
                  {bill.paidAt ? <Row label="On" value={bill.paidAt.slice(0, 10)} /> : null}
                  {detail.paymentName ? <Row label="From" value={detail.paymentName} /> : null}
                </View>
              </View>
            ) : null}

            {/* Meta */}
            <View className="mt-8 space-y-3">
              <Row label="Category" value={detail.categoryName ?? '—'} />
              <Row label="Bill date" value={bill.billDate} />
              <Row label="Due date" value={bill.dueDate} />
              {bill.reference ? <Row label="Reference" value={`#${bill.reference}`} /> : null}
              {bill.memo ? <Row label="Memo" value={bill.memo} /> : null}
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
