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
import { MoneyAccountPicker, useMoneyAccounts } from '../../../../components/MoneyAccountPicker';
import { api } from '../../../../lib/api';
import { apiErrorMessage } from '../../../../lib/api-errors';
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
  | {
      state: 'ready';
      bill: Bill;
      categoryName: string | null;
      paymentName: string | null;
    }
  | { state: 'error' };

// The payments list + derived settlement from GET /api/bills/:id/payments
// (TMC-192).
type Settlement = {
  settlement: 'unpaid' | 'partial' | 'paid' | 'overpaid';
  paid: string;
  outstanding: string;
  status: 'open' | 'paid';
  payments: {
    id: string;
    amount: string;
    paidOn: string;
    method: string;
    reference: string | null;
    paymentAccountId: string | null;
  }[];
};

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
  // The refusals partial payments made reachable (TMC-192). Without these the
  // raw code reaches the screen — apiErrorMessage passes unknown codes through
  // unchanged. Same sentences as the web bill detail.
  has_payments: 'This bill has payments recorded against it — remove or refund those first.',
  settled_without_payments:
    'This bill was settled in one go, so there is nothing left to record against it.',
  voided: 'This bill was voided, so no more money can be recorded against it.',
  invalid_payment_account: "That account isn't one a bill can be paid from.",
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

  // Partial payments (TMC-192) — the vendor-deposit path. The mark-paid panel
  // above settles the whole amount in one shot; this is where a deposit, a
  // progress payment, or a refund from the vendor lives.
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [showPaymentPanel, setShowPaymentPanel] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payOn, setPayOn] = useState(todayIso());
  const [payMethod, setPayMethod] = useState<BillPaymentMethod>('cash');
  const [payReference, setPayReference] = useState('');
  // Direction rather than a typed minus sign — nobody should have to know that
  // a refund from the vendor is a negative payment.
  const [payDirection, setPayDirection] = useState<'out' | 'in'>('out');
  // Which account the money leaves (TMC-207). Cards included: paying one card
  // off with another is unusual but real, and the ledger treats it the same.
  const [payAccountId, setPayAccountId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api.api.bills[':id'].$get({ param: { id } });
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
    // Payments + derived settlement. Best-effort like the audit trail below —
    // losing the payments panel is better than blanking the whole bill.
    try {
      const payRes = await api.api.bills[':id'].payments.$get({ param: { id } });
      if (payRes.ok) setSettlement((await payRes.json()) as Settlement);
    } catch {}
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
  // Loaded once the bill is known, since the accounts are company-scoped.
  const moneyAccounts = useMoneyAccounts(bill?.companyId ?? null);
  const isOpen = bill?.status === 'open';
  const canAct = canWrite && isOpen;

  // Gated the way the server gates it: an open bill always, a paid one only if
  // it got there through payment rows (a legacy header-only settlement stays
  // closed). Mirroring the server rule keeps the UI from offering an action the
  // API will refuse.
  const canRecordPayment =
    canWrite &&
    !!settlement &&
    (bill?.status === 'open' || (bill?.status === 'paid' && settlement.payments.length > 0));

  // mark-paid settles the whole amount in one shot and the server refuses it
  // once payments exist, so the quick button hides as soon as the bill is
  // partly settled — the panel below is the way in from then on.
  const canMarkPaid = canAct && (settlement?.payments.length ?? 0) === 0;

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
        setTransitionError(
          TRANSITION_ERRORS[apiErrorMessage(body?.error, '', body)] ??
            apiErrorMessage(body?.error, 'Action failed.', body),
        );
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
        api.api.bills[':id']['mark-paid'].$post({
          param: { id },
          json: {
            method: paidMethod,
            reference: reference || undefined,
            paidOn,
            // Omitted → the server's primary account, which is what a company
            // with one place to pay from has always used.
            paymentAccountId: payAccountId ?? undefined,
          },
        }),
      () => setShowPaidPanel(false),
    );
  }

  function onRecordPayment() {
    const raw = payAmount.trim();
    if (!raw) {
      setTransitionError('Enter an amount.');
      return;
    }
    const amount = payDirection === 'in' ? `-${raw.replace(/^-/, '')}` : raw;
    const reference = payReference.trim();
    act(
      () =>
        api.api.bills[':id'].payments.$post({
          param: { id },
          json: {
            amount,
            paidOn: payOn,
            method: payMethod,
            reference: reference || undefined,
            paymentAccountId: payAccountId ?? undefined,
          },
        }),
      () => {
        setShowPaymentPanel(false);
        setPayAmount('');
        setPayReference('');
        setPayDirection('out');
      },
    );
  }

  function onRemovePayment(paymentId: string) {
    Alert.alert('Remove this payment?', 'It is undone, not deleted. The record stays.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () =>
          act(() =>
            api.api.bills[':id'].payments[':paymentId'].$delete({ param: { id, paymentId } }),
          ),
      },
    ]);
  }

  function onVoid() {
    Alert.alert('Void bill?', 'This takes it back off your books and cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Void',
        style: 'destructive',
        onPress: () => act(() => api.api.bills[':id'].void.$post({ param: { id } })),
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
                  {canMarkPaid ? (
                    <Pressable
                      onPress={() => setShowPaidPanel((v) => !v)}
                      disabled={acting}
                      className="flex-1 rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
                    >
                      <Text className="text-center text-sm font-medium text-cream">Mark paid</Text>
                    </Pressable>
                  ) : null}
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
            {canMarkPaid && showPaidPanel ? (
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
                  <MoneyAccountPicker
                    accounts={moneyAccounts}
                    value={payAccountId ?? moneyAccounts?.[0]?.id ?? null}
                    onChange={setPayAccountId}
                  />
                </View>
                <Pressable
                  onPress={onMarkPaid}
                  disabled={acting}
                  className="mt-4 rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
                >
                  <Text className="text-center text-sm font-medium text-cream">Pay in full</Text>
                </Pressable>
              </View>
            ) : null}

            {/* Payments (TMC-192) — deposits, progress payments, refunds */}
            {settlement && (settlement.payments.length > 0 || canRecordPayment) ? (
              <View className="mt-6 rounded-sm border border-ink/10 bg-cream-warm p-4">
                <Text className="font-serif text-lg font-light text-ink">Payments</Text>
                <Text className="mt-1 text-sm text-ink/70">
                  {settlement.settlement === 'overpaid'
                    ? `Overpaid by $${Math.abs(Number(settlement.outstanding)).toFixed(2)}`
                    : settlement.settlement === 'paid'
                      ? 'Paid in full'
                      : `$${Number(settlement.paid).toFixed(2)} of $${Number(bill.amount).toFixed(2)} · $${Number(settlement.outstanding).toFixed(2)} still owing`}
                </Text>

                {settlement.payments.map((p) => (
                  <View
                    key={p.id}
                    className="mt-3 flex-row items-start justify-between border-t border-ink/10 pt-3"
                  >
                    <View className="flex-1 pr-3">
                      <Text className="text-sm text-ink">
                        {Number(p.amount) < 0 ? 'Refund ' : ''}$
                        {Math.abs(Number(p.amount)).toFixed(2)}
                      </Text>
                      <Text className="mt-0.5 text-xs text-ink/50">
                        {p.paidOn} · {PAYMENT_METHOD_LABELS[p.method] ?? p.method}
                        {p.reference ? ` · ${p.reference}` : ''}
                      </Text>
                    </View>
                    {canRecordPayment ? (
                      <Pressable onPress={() => onRemovePayment(p.id)} disabled={acting}>
                        <Text className="font-mono text-xs uppercase tracking-widest text-ink/40">
                          Remove
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                ))}

                {canRecordPayment && !showPaymentPanel ? (
                  <Pressable
                    onPress={() => {
                      setShowPaymentPanel(true);
                      // Pre-fill only when something is genuinely outstanding.
                      // On a settled bill the balance is "0.00", and handing
                      // that to the user is handing them an amount the API
                      // refuses — a zero-amount payment is rejected, correctly.
                      // The empty-input guard in onRecordPayment doesn't save it
                      // either, because "0.00" is not empty (TMC-197 on the
                      // invoice side; same trap, same fix).
                      setPayAmount(
                        Number(settlement.outstanding) > 0 ? settlement.outstanding : '',
                      );
                    }}
                    className="mt-4 rounded-sm border border-ink/20 px-4 py-2.5 active:border-gold-deep"
                  >
                    <Text className="text-center font-mono text-xs uppercase tracking-widest text-ink/70">
                      Record a payment
                    </Text>
                  </Pressable>
                ) : null}

                {canRecordPayment && showPaymentPanel ? (
                  <View className="mt-4 border-t border-ink/10 pt-4">
                    <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                      Amount
                    </Text>
                    <TextInput
                      value={payAmount}
                      onChangeText={setPayAmount}
                      keyboardType="decimal-pad"
                      placeholder="0.00"
                      className="mt-1 rounded-sm border border-ink/20 bg-cream px-3 py-2.5 text-ink"
                    />

                    <View className="mt-4">
                      <DateField label="Date paid" value={payOn} onChange={setPayOn} />
                    </View>

                    <Text className="mt-4 font-mono text-xs uppercase tracking-widest text-ink/50">
                      Method
                    </Text>
                    <View className="mt-2 flex-row flex-wrap gap-2">
                      {BILL_PAYMENT_METHODS.map((m) => (
                        <Pressable
                          key={m}
                          onPress={() => setPayMethod(m)}
                          className={`rounded-sm border px-3 py-1.5 ${
                            payMethod === m ? 'border-gold-deep bg-ink' : 'border-ink/20'
                          }`}
                        >
                          <Text
                            className={`text-xs ${payMethod === m ? 'text-cream' : 'text-ink/70'}`}
                          >
                            {PAYMENT_METHOD_LABELS[m] ?? m}
                          </Text>
                        </Pressable>
                      ))}
                    </View>

                    <Text className="mt-4 font-mono text-xs uppercase tracking-widest text-ink/50">
                      Type
                    </Text>
                    <View className="mt-2 flex-row gap-2">
                      {(
                        [
                          ['out', 'Payment made'],
                          ['in', 'Refund from vendor'],
                        ] as const
                      ).map(([value, label]) => (
                        <Pressable
                          key={value}
                          onPress={() => setPayDirection(value)}
                          className={`rounded-sm border px-3 py-1.5 ${
                            payDirection === value ? 'border-gold-deep bg-ink' : 'border-ink/20'
                          }`}
                        >
                          <Text
                            className={`text-xs ${
                              payDirection === value ? 'text-cream' : 'text-ink/70'
                            }`}
                          >
                            {label}
                          </Text>
                        </Pressable>
                      ))}
                    </View>

                    {/* No "paid from" picker — see the web bill detail for the
                        reasoning: the chart is seed-only and Cash is the only
                        account money can leave from, so the server resolves it
                        and the choice waits for a second bank account. */}
                    <Text className="mt-4 font-mono text-xs uppercase tracking-widest text-ink/50">
                      Reference (optional)
                    </Text>
                    <TextInput
                      value={payReference}
                      onChangeText={setPayReference}
                      placeholder="Check number, confirmation code"
                      className="mt-1 rounded-sm border border-ink/20 bg-cream px-3 py-2.5 text-ink"
                    />

                    <Pressable
                      onPress={onRecordPayment}
                      disabled={acting}
                      className="mt-4 rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
                    >
                      <Text className="text-center text-sm font-medium text-cream">
                        Record payment
                      </Text>
                    </Pressable>
                    <Pressable onPress={() => setShowPaymentPanel(false)} className="mt-3">
                      <Text className="text-center font-mono text-xs uppercase tracking-widest text-ink/50">
                        Cancel
                      </Text>
                    </Pressable>
                  </View>
                ) : null}
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
