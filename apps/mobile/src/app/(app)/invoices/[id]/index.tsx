import { formatUnitPrice } from '@thalermark/validation';
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
import { useMay } from '../../../../lib/role';
import { getServerUrl } from '../../../../lib/server-url';

// Invoice detail + status actions (mirror of apps/web's /invoices/[id]):
// mark-sent / mark-paid / void / send-by-email, gated by the same state
// machine the API enforces (INVOICE_TRANSITIONS). Edit is draft-only (M11c);
// duplicate / edit-payment / Stripe pay link are deferred to later slices.
type LineItem = {
  position: number;
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  taxable: boolean;
  taxRatePct: string;
};
type Invoice = {
  status: string;
  number: string;
  contactId: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  subtotal: string;
  tax: string | null;
  total: string;
  notes: string | null;
  publicToken: string | null;
  paymentMethod: string | null;
  paymentReference: string | null;
  paidAt: string | null;
  lineItems: LineItem[];
};
type DetailState =
  | { state: 'loading' }
  | { state: 'ready'; invoice: Invoice; customerName: string | null; contactEmail: string | null }
  | { state: 'error' };

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  check: 'Check',
  venmo: 'Venmo',
  zelle: 'Zelle',
  stripe: 'Card (Stripe)',
  other: 'Other',
};
const PAID_METHODS = ['cash', 'check', 'venmo', 'zelle', 'other'] as const;

const TRANSITION_ERRORS: Record<string, string> = {
  invalid_transition: 'This invoice can no longer be changed.',
  invalid_recipient: 'Add a contact email or enter one to send.',
  email_not_configured: "Email isn't configured on this server.",
  contact_not_found: 'The contact for this invoice no longer exists.',
};

const todayIso = () => new Date().toISOString().slice(0, 10);

export default function InvoiceDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [detail, setDetail] = useState<DetailState>({ state: 'loading' });
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [acting, setActing] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  // Send override + mark-paid panel UI state.
  const [showOverride, setShowOverride] = useState(false);
  const [overrideEmail, setOverrideEmail] = useState('');
  const [showPaidPanel, setShowPaidPanel] = useState(false);
  const [paidMethod, setPaidMethod] = useState<(typeof PAID_METHODS)[number]>('cash');
  const [paidReference, setPaidReference] = useState('');
  const [paidOn, setPaidOn] = useState(todayIso());

  const load = useCallback(async () => {
    const res = await api.api.invoices[':id'].$get({ param: { id } });
    if (!res.ok) {
      setDetail({ state: 'error' });
      return;
    }
    const inv = await res.json();
    let customerName: string | null = null;
    let contactEmail: string | null = null;
    const custRes = await api.api.contacts[':id'].$get({ param: { id: inv.contactId } });
    if (custRes.ok) {
      const c = await custRes.json();
      customerName = c.name;
      contactEmail = c.email ?? null;
    }
    setDetail({
      state: 'ready',
      customerName,
      contactEmail,
      invoice: {
        status: inv.status,
        number: inv.number,
        contactId: inv.contactId,
        issueDate: inv.issueDate,
        dueDate: inv.dueDate,
        currency: inv.currency,
        subtotal: inv.subtotal,
        tax: inv.tax ?? null,
        total: inv.total,
        notes: inv.notes ?? null,
        publicToken: inv.publicToken ?? null,
        paymentMethod: inv.paymentMethod ?? null,
        paymentReference: inv.paymentReference ?? null,
        paidAt: inv.paidAt ?? null,
        lineItems: inv.lineItems,
      },
    });
    // Audit trail — best-effort; refetched on every load() (focus + after each
    // in-screen transition), so the history reflects the action just taken. A
    // failure here must not flip the whole screen to error, hence the swallow.
    try {
      const auditRes = await api.api['audit-events'].$get({
        query: { entityType: 'invoice', entityId: id },
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

  // Role gate (UX only — the API is authoritative). Every invoice write and
  // state action is `sales:write`; each status gate is ANDed with it so a
  // viewer/accountant sees no action buttons.
  const canWrite = useMay('sales:write');
  const inv = detail.state === 'ready' ? detail.invoice : null;
  const status = inv?.status;
  const canSend = canWrite && (status === 'draft' || status === 'sent');
  const canMarkSent = canWrite && status === 'draft';
  const canMarkPaid = canWrite && (status === 'draft' || status === 'sent');
  const canVoid = canWrite && (status === 'draft' || status === 'sent');
  const canEdit = canWrite && status === 'draft';
  const hasActions = canSend || canMarkSent || canMarkPaid || canVoid;

  // Run a transition, then reload. `onOk` records any success side effect
  // (e.g. the "sent to" banner) before the refresh. The fn returns an hc
  // ClientResponse — typed structurally so RN's FormData/global mismatch on
  // the full Response type doesn't surface here.
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

  function onSend() {
    const to = showOverride ? overrideEmail.trim() : '';
    const recipient = to || (detail.state === 'ready' ? detail.contactEmail : null);
    act(
      () => api.api.invoices[':id'].send.$post({ param: { id }, json: to ? { to } : {} }),
      () => {
        setSentTo(recipient);
        setShowOverride(false);
      },
    );
  }

  function onMarkPaid() {
    const reference = paidReference.trim();
    act(
      () =>
        api.api.invoices[':id']['mark-paid'].$post({
          param: { id },
          json: { method: paidMethod, reference: reference || undefined, paidOn },
        }),
      () => setShowPaidPanel(false),
    );
  }

  // Duplicate-as-template — clone into a fresh draft (the server carries the
  // line sourceItemIds forward) and land on its edit screen. Any status.
  async function onDuplicate() {
    setDuplicating(true);
    setTransitionError(null);
    try {
      const res = await api.api.invoices[':id'].duplicate.$post({ param: { id } });
      if (!res.ok) {
        setTransitionError('Could not duplicate this invoice.');
        return;
      }
      const { id: newId } = await res.json();
      router.push(`/invoices/${newId}/edit`);
    } catch {
      setTransitionError('Could not duplicate this invoice.');
    } finally {
      setDuplicating(false);
    }
  }

  function onVoid() {
    Alert.alert('Void invoice?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Void',
        style: 'destructive',
        onPress: () => act(() => api.api.invoices[':id'].void.$post({ param: { id } })),
      },
    ]);
  }

  const publicUrl = inv?.publicToken ? `${getServerUrl()}/i/${inv.publicToken}` : null;
  const paidVia =
    inv?.status === 'paid' && inv.paymentMethod
      ? (PAYMENT_METHOD_LABELS[inv.paymentMethod] ?? inv.paymentMethod)
      : null;

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16" keyboardShouldPersistTaps="handled">
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
              <View className="flex-row items-center gap-3">
                {canEdit ? (
                  <Pressable
                    onPress={() => router.push(`/invoices/${id}/edit`)}
                    className="rounded-sm border border-ink/20 px-3 py-1.5 active:border-gold-deep"
                  >
                    <Text className="font-mono text-xs uppercase tracking-widest text-ink/70">
                      Edit
                    </Text>
                  </Pressable>
                ) : null}
                {canWrite ? (
                  <Pressable
                    onPress={onDuplicate}
                    disabled={duplicating}
                    className="rounded-sm border border-ink/20 px-3 py-1.5 active:border-gold-deep disabled:opacity-50"
                  >
                    <Text className="font-mono text-xs uppercase tracking-widest text-ink/70">
                      {duplicating ? '…' : 'Duplicate'}
                    </Text>
                  </Pressable>
                ) : null}
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
                  {inv.status}
                </Text>
              </View>
            </View>

            {transitionError ? (
              <View className="mt-4 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
                <Text className="text-sm text-oxblood">{transitionError}</Text>
              </View>
            ) : null}
            {sentTo ? (
              <View className="mt-4 rounded-sm border border-gold-deep/30 bg-gold-deep/5 px-4 py-3">
                <Text className="text-sm text-ink">
                  Sent to <Text className="font-medium">{sentTo}</Text>.
                </Text>
              </View>
            ) : null}

            {/* Action toolbar */}
            {hasActions ? (
              <View className="mt-6 space-y-3">
                {canSend ? (
                  <View>
                    {showOverride ? (
                      <TextInput
                        value={overrideEmail}
                        onChangeText={setOverrideEmail}
                        placeholder={detail.contactEmail ?? 'recipient@example.com'}
                        keyboardType="email-address"
                        autoCapitalize="none"
                        className="mb-2 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink"
                      />
                    ) : null}
                    <View className="flex-row gap-2">
                      <Pressable
                        onPress={onSend}
                        disabled={acting}
                        className="flex-1 rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
                      >
                        <Text className="text-center text-sm font-medium text-cream">
                          {inv.status === 'sent' ? 'Resend invoice' : 'Send invoice'}
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => setShowOverride((v) => !v)}
                        className="rounded-sm border border-ink/20 px-3 py-3 active:bg-ink/5"
                      >
                        <Text className="font-mono text-xs uppercase tracking-widest text-ink/70">
                          {showOverride ? 'Cancel' : 'To…'}
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                ) : null}

                <View className="flex-row gap-2">
                  {canMarkPaid ? (
                    <Pressable
                      onPress={() => setShowPaidPanel((v) => !v)}
                      disabled={acting}
                      className="flex-1 rounded-sm border border-ink/20 px-4 py-3 active:bg-ink/5 disabled:opacity-50"
                    >
                      <Text className="text-center text-sm font-medium text-ink">Mark paid</Text>
                    </Pressable>
                  ) : null}
                  {canVoid ? (
                    <Pressable
                      onPress={onVoid}
                      disabled={acting}
                      className="flex-1 rounded-sm border border-oxblood/30 px-4 py-3 active:bg-oxblood/5 disabled:opacity-50"
                    >
                      <Text className="text-center text-sm font-medium text-oxblood">Void</Text>
                    </Pressable>
                  ) : null}
                </View>

                {canMarkSent ? (
                  <Pressable
                    onPress={() =>
                      act(() => api.api.invoices[':id']['mark-sent'].$post({ param: { id } }))
                    }
                    disabled={acting}
                  >
                    <Text className="text-xs uppercase tracking-widest text-ink/50">
                      Mark sent without email
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}

            {/* Mark-paid panel */}
            {canMarkPaid && showPaidPanel ? (
              <View className="mt-4 rounded-sm border border-ink/15 bg-cream-warm p-4">
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                  How was it paid?
                </Text>
                <View className="mt-3 flex-row flex-wrap gap-2">
                  {PAID_METHODS.map((m) => (
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
                  <Text className="text-center text-sm font-medium text-cream">Confirm paid</Text>
                </Pressable>
              </View>
            ) : null}

            {/* Share link */}
            {publicUrl ? (
              <View className="mt-6 rounded-sm border border-ink/10 bg-cream-warm p-4">
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                  Share link
                </Text>
                <Text className="mt-2 text-sm text-gold-deep">{publicUrl}</Text>
                <Text className="mt-2 text-xs text-ink/50">
                  Anyone with this link can view the invoice.
                </Text>
              </View>
            ) : null}

            {/* Meta */}
            <View className="mt-8 space-y-2">
              <Meta label="Contact" value={detail.customerName ?? '—'} />
              <Meta label="Issued" value={inv.issueDate} />
              <Meta label="Due" value={inv.dueDate} />
              {paidVia ? (
                <Meta
                  label="Paid via"
                  value={paidVia + (inv.paymentReference ? ` · ${inv.paymentReference}` : '')}
                />
              ) : null}
              {inv.status === 'paid' && inv.paidAt ? (
                <Meta label="Paid on" value={inv.paidAt.slice(0, 10)} />
              ) : null}
            </View>

            {/* Line items + totals */}
            <View className="mt-8 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
              {inv.lineItems.map((li) => (
                <View key={li.position} className="border-b border-ink/10 px-4 py-3">
                  <Text className="text-ink">{li.description}</Text>
                  {li.taxable ? (
                    <Text className="mt-0.5 text-[10px] text-ink/40">
                      Taxable · {Number(li.taxRatePct)}%
                    </Text>
                  ) : null}
                  <View className="mt-1 flex-row justify-between">
                    <Text className="font-mono text-xs text-ink/50">
                      {String(Number(li.quantity))} × {formatUnitPrice(li.unitPrice)}
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

            <AuditHistory events={auditEvents} />
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
