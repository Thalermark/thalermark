import { formatQuantity, formatUnitPrice } from '@thalermark/validation';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Share,
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
import { getServerUrl } from '../../../../lib/server-url';
import { shareLink } from '../../../../lib/share-link';

// Invoice detail + status actions (mirror of apps/web's /invoices/[id]):
// mark-sent / mark-paid / void / send-by-email, gated by the same state
// machine the API enforces (INVOICE_TRANSITIONS). Edit is draft-only (M11c);
// duplicate / edit-payment / Stripe pay link are deferred to later slices.
type LineItem = {
  position: number;
  description: string;
  quantity: string;
  unitLabel: string | null;
  unitPrice: string;
  amount: string;
  taxable: boolean;
  taxRatePct: string;
};
type Invoice = {
  status: string;
  number: string;
  contactId: string;
  // Needed to scope the money-account lookup, which is per company.
  companyId: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  subtotal: string;
  tax: string | null;
  total: string;
  notes: string | null;
  // Needed for the derived "being revised" state: 'draft' with a sent_at is an
  // invoice pulled back to be corrected (TMC-227).
  sentAt: string | null;
  publicToken: string | null;
  paymentMethod: string | null;
  paymentReference: string | null;
  paidAt: string | null;
  // Per-invoice reminder opt-out (TMC-189). Optional so an older API build,
  // which a mobile binary in the stores may well be talking to, simply reads
  // undefined rather than the screen failing to parse the invoice at all.
  remindersOptedOut?: boolean;
  lineItems: LineItem[];
  // Every pull-back so far, newest first (TMC-227). Empty for almost every
  // invoice; the nudge reads the most recent one's date.
  revisions: { revisedAt: string; previousTotal: string }[];
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

// The payments list + derived settlement from GET /api/invoices/:id/payments.
// Declared locally rather than inferred off the client so the screen keeps
// compiling if the route's response shape is widened.
type Settlement = {
  settlement: 'unpaid' | 'partial' | 'paid' | 'overpaid';
  paid: string;
  outstanding: string;
  payments: {
    id: string;
    amount: string;
    receivedOn: string;
    method: string;
    reference: string | null;
  }[];
};

const TRANSITION_ERRORS: Record<string, string> = {
  invalid_transition: 'This invoice can no longer be changed.',
  invalid_recipient: 'Add a contact email or enter one to send.',
  email_not_configured: "Email isn't configured on this server.",
  contact_not_found: 'The contact for this invoice no longer exists.',
  // The settlement guards (TMC-187), which had no copy on either client — an
  // unmapped code reaches the screen unchanged, so voiding a part-paid invoice
  // showed the string "has_payments". Same sentences the web detail uses.
  has_payments: 'This invoice has payments recorded against it — remove or refund those first.',
  settled_without_payments:
    'This invoice was settled in one go, so there is nothing left to record against it.',
  voided: 'This invoice was voided, so no more money can be recorded against it.',
  not_issued: 'Send this invoice first — there is nothing owed on a draft to pay down.',
  // Correcting a sent invoice (TMC-227). Same sentences the web detail uses.
  invoice_paid:
    'This invoice has been paid. Remove or refund the payment first, then pull it back to fix it.',
  revision_in_progress:
    'This invoice is being fixed. Resend the corrected one first, then change its payments.',
};

const todayIso = () => new Date().toISOString().slice(0, 10);

// Idempotency key for the deposit path, which welds a state transition to a
// money insert and must not run twice. Only needs to be unique, not secret, so
// prefer a real UUID where the runtime has one and fall back otherwise. Same
// approach as AddressField's session token, and no extra dependency.
function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function InvoiceDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [detail, setDetail] = useState<DetailState>({ state: 'loading' });
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [acting, setActing] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  // Did the email actually leave the building? The console mailer logs the
  // message and resolves, which looks exactly like a real send — so the server
  // tells us, and this screen stops asserting a delivery it can't vouch for
  // (TMC-212). Defaults to true: an older API omits `delivered`, and silence
  // must not raise a warning.
  const [sendDelivered, setSendDelivered] = useState(true);

  // Send override + mark-paid panel UI state.
  const [showOverride, setShowOverride] = useState(false);
  const [overrideEmail, setOverrideEmail] = useState('');
  const [showPaidPanel, setShowPaidPanel] = useState(false);
  const [paidMethod, setPaidMethod] = useState<(typeof PAID_METHODS)[number]>('cash');
  const [paidReference, setPaidReference] = useState('');
  const [paidOn, setPaidOn] = useState(todayIso());

  // Partial payments (TMC-187) — the deposit path. The mark-paid panel above
  // stays the one-tap "they paid it all"; this records one receipt at a time.
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [showPaymentPanel, setShowPaymentPanel] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState<(typeof PAID_METHODS)[number]>('cash');
  const [payReference, setPayReference] = useState('');
  const [payOn, setPayOn] = useState(todayIso());
  // Direction rather than a typed minus sign — nobody should have to know that
  // a refund is stored as a negative payment.
  const [payDirection, setPayDirection] = useState<'in' | 'out'>('in');
  // Taking a deposit on a draft, in one question (TMC-199 / TMC-271). Collapsed
  // by default: most drafts never take a deposit, and an open form on every one
  // of them is noise. The key is minted when the form opens and cleared after a
  // success, so a double-tap replays the same deposit server-side rather than
  // booking a second one; a genuine second deposit gets a fresh key.
  const [showDeposit, setShowDeposit] = useState(false);
  const [depositAmount, setDepositAmount] = useState('');
  const [depositKey, setDepositKey] = useState<string | null>(null);
  // One sentence's worth of doubt about the invoice about to go out, or null —
  // which is the ordinary answer (TMC-227).
  const [sendConcern, setSendConcern] = useState<string | null>(null);

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
        companyId: inv.companyId,
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
        sentAt: inv.sentAt ?? null,
        publicToken: inv.publicToken ?? null,
        paymentMethod: inv.paymentMethod ?? null,
        paymentReference: inv.paymentReference ?? null,
        paidAt: inv.paidAt ?? null,
        lineItems: inv.lineItems,
        revisions: inv.revisions ?? [],
      },
    });
    // Receipts + derived settlement. Best-effort like the audit trail below —
    // losing the payments panel is better than blanking the whole invoice.
    try {
      const payRes = await api.api.invoices[':id'].payments.$get({ param: { id } });
      if (payRes.ok) setSettlement((await payRes.json()) as Settlement);
    } catch {}
    // The typo catcher (TMC-227). Fetched on load, not on tap: this client is
    // the one being used standing in a customer's yard on one bar of signal,
    // and a check the user has to wait for is a check they learn to tap
    // through. Best-effort — no callout beats a blocked send.
    try {
      const checkRes = await api.api.invoices[':id']['send-check'].$get({ param: { id } });
      if (checkRes.ok) setSendConcern((await checkRes.json()).concern);
    } catch {}
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
  // Where a receipt lands (TMC-207). Bank accounts only — nothing is ever
  // deposited into a credit card.
  const depositAccounts = useMoneyAccounts(inv?.companyId ?? null, false);
  const [depositAccountId, setDepositAccountId] = useState<string | null>(null);
  const status = inv?.status;
  // Pulled back to be corrected and not yet resent (TMC-227). A DERIVED label,
  // not a status — same shape as the overdue/expired labels, and for the same
  // reason: a sixth enum value would have to be understood by the ledger, every
  // report and both clients at once.
  const isRevising = status === 'draft' && inv?.sentAt != null;
  const statusLabel = isRevising ? 'being revised' : status;
  const pulledBackOn = inv?.revisions?.[0]?.revisedAt
    ? ` on ${inv.revisions[0].revisedAt.slice(0, 10)}`
    : '';
  const canSend = canWrite && (status === 'draft' || status === 'sent');
  const canMarkSent = canWrite && status === 'draft';
  const canRevise = canWrite && status === 'sent';
  // Refused server-side while a correction is in flight — mark-paid on a draft
  // posts a counter-sale receipt, which would credit a receivable that has just
  // been reversed. Hidden so the button never offers a certain 409.
  const canMarkPaid = canWrite && !isRevising && (status === 'draft' || status === 'sent');
  // Void stays available while revising: "pulled it back, then decided to kill
  // it" is a real ending, and draft → voided posts nothing.
  const canVoid = canWrite && (status === 'draft' || status === 'sent');
  const canEdit = canWrite && status === 'draft';
  const hasActions = canSend || canMarkSent || canRevise || canMarkPaid || canVoid;

  // Run a transition, then reload. `onOk` records any success side effect
  // (e.g. the "sent to" banner) before the refresh. The fn returns an hc
  // ClientResponse — typed structurally so RN's FormData/global mismatch on
  // the full Response type doesn't surface here.
  async function act(
    fn: () => Promise<{ ok: boolean; json: () => Promise<unknown> }>,
    onOk?: (body: unknown) => void,
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
      // The success body too, so a caller can read what the server actually
      // did — /send reports whether the email really went out. Best-effort:
      // a body that isn't JSON just yields null (matches the estimate screen).
      onOk?.(await res.json().catch(() => null));
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
      (body) => {
        const sent = body as { sentTo?: string; delivered?: boolean } | null;
        setSentTo(sent?.sentTo ?? recipient);
        // Only an explicit `false` is a non-delivery; undefined is an older
        // server that never told us, and we don't scare people over that.
        setSendDelivered(sent?.delivered !== false);
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
          json: {
            method: paidMethod,
            reference: reference || undefined,
            paidOn,
            // Omitted → the server's primary account.
            depositAccountId: depositAccountId ?? undefined,
          },
        }),
      () => setShowPaidPanel(false),
    );
  }

  // Silence (or resume) automated chasing for this one invoice (TMC-189). Its
  // own endpoint rather than the invoice PATCH, which is draft-only and would
  // reject every SENT invoice — i.e. every invoice reminders apply to.
  function onSetReminders(optedOut: boolean) {
    act(() => api.api.invoices[':id'].reminders.$post({ param: { id }, json: { optedOut } }));
  }

  function onRecordPayment() {
    const raw = payAmount.trim();
    if (!raw) {
      setTransitionError('Enter an amount.');
      return;
    }
    const amount = payDirection === 'out' ? `-${raw.replace(/^-/, '')}` : raw;
    const reference = payReference.trim();
    act(
      () =>
        api.api.invoices[':id'].payments.$post({
          param: { id },
          json: {
            amount,
            receivedOn: payOn,
            method: payMethod,
            reference: reference || undefined,
            depositAccountId: depositAccountId ?? undefined,
          },
        }),
      () => {
        setShowPaymentPanel(false);
        setPayAmount('');
        setPayReference('');
        setPayDirection('in');
      },
    );
  }

  // Issues the invoice AND records the deposit in one server transaction, so
  // the operator answers one question instead of walking a state machine. The
  // amount is the only thing the person holding the cash actually knows.
  function onTakeDeposit() {
    const amount = depositAmount.trim();
    if (!amount) {
      setTransitionError('Enter how much they paid.');
      return;
    }
    const key = depositKey ?? newIdempotencyKey();
    if (!depositKey) setDepositKey(key);
    act(
      () =>
        api.api.invoices[':id'].deposit.$post({
          param: { id },
          json: { amount, idempotencyKey: key },
        }),
      () => {
        setShowDeposit(false);
        setDepositAmount('');
        setDepositKey(null);
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
            api.api.invoices[':id'].payments[':paymentId'].$delete({ param: { id, paymentId } }),
          ),
      },
    ]);
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

  // "Fix this invoice" (TMC-227). Confirmed, but not destructive — nothing is
  // lost by pulling an invoice back. What the dialog exists for is that the
  // CUSTOMER sees the change, which the body spells out. Same copy as web.
  function onRevise() {
    Alert.alert(
      'Fix this invoice?',
      "It goes back to a draft you can edit. The customer's link will say it's being revised, and the amount comes off your books until you resend it.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Pull it back',
          onPress: () => act(() => api.api.invoices[':id'].revise.$post({ param: { id } })),
        },
      ],
    );
  }

  // Mirrors the API's eligibility rule so the button never offers a certain
  // 409: an issued invoice, and a settled one only if it got there through
  // payment rows (a legacy header-only settlement stays closed).
  //
  // Plus: a zero-total invoice has nothing to receive (TMC-281). It used to
  // offer this, and the control could not succeed usefully — a zero amount is
  // refused by the payment schema, while a positive one is ACCEPTED and books
  // an overpayment against an invoice that never asked for anything. The
  // mark-paid path already carves out total = 0, the same exception migration
  // 0032 made; the payments panel never got the equivalent.
  //
  // Gated on the TOTAL, deliberately, NOT on `settlement.outstanding`. The
  // API's own rule (checkPaymentEligibility, apps/api/src/lib/invoice-payments.ts)
  // never looks at an amount, so an already-settled invoice can still take
  // another payment — that is how a real overpayment gets recorded, and the
  // panel has an "Overpaid by" state for exactly that. Gating on outstanding
  // would make the client stricter than the server and break it. Keep this
  // rule identical to web's; the two are character-for-character the same by
  // design.
  const canRecordPayment =
    canWrite &&
    !!settlement &&
    Number(inv?.total ?? 0) > 0 &&
    (status === 'sent' || (status === 'paid' && settlement.payments.length > 0));

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
          className="font-mono text-xs uppercase tracking-widest text-ink-subtle"
        >
          ← Invoices
        </Text>

        {detail.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator className="text-ink" />
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
                    <Text className="font-mono text-xs uppercase tracking-widest text-ink-muted">
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
                    <Text className="font-mono text-xs uppercase tracking-widest text-ink-muted">
                      {duplicating ? '…' : 'Duplicate'}
                    </Text>
                  </Pressable>
                ) : null}
                <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                  {statusLabel}
                </Text>
              </View>
            </View>

            {isRevising ? (
              /* The stranded-draft nudge (TMC-227). Correcting is three actions
                 and the middle one leaves this screen, so it is easy to stop
                 after two — leaving a customer holding a link that says the
                 invoice is being revised and money off the books. */
              <View className="mt-4 rounded-sm border border-gold-deep/40 bg-gold-deep/5 px-4 py-3">
                {/* One interpolated string, not text interleaved with
                    expressions: JSX strips the whitespace at each line's edge,
                    which ran the date into the words on both sides ("pulled
                    this backon 2026-08-11— the customer's"). */}
                <Text className="text-sm text-ink">
                  {`You pulled this back${pulledBackOn} — the customer's link says it's being revised, and the amount is off your books, until you resend the corrected invoice.`}
                </Text>
              </View>
            ) : null}

            {transitionError ? (
              <View className="mt-4 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
                <Text className="text-sm text-oxblood">{transitionError}</Text>
              </View>
            ) : null}
            {sentTo ? (
              sendDelivered ? (
                <View className="mt-4 rounded-sm border border-gold-deep/30 bg-gold-deep/5 px-4 py-3">
                  <Text className="text-sm text-ink">
                    Sent to <Text className="font-medium">{sentTo}</Text>.
                  </Text>
                </View>
              ) : (
                <View className="mt-4 rounded-sm border border-copper/40 bg-copper/5 px-4 py-3">
                  <Text className="text-sm text-ink">
                    Marked as sent — but <Text className="font-medium">no email was delivered</Text>
                    . This server has no email set up, so nothing reached {sentTo}. The invoice is
                    issued and its pay link works; send the customer that link yourself.
                  </Text>
                </View>
              )
            ) : null}

            {/* The typo catcher (TMC-227), directly above the Send control —
                where the decision is made. It never blocks, has no dismissal
                state and nothing to remember between screens: it is a sentence
                and a way to disagree with it. Copper, not the oxblood Void
                wears, because nothing is wrong yet and dressing a maybe as an
                error is how a warning gets trained out of someone. */}
            {canSend && sendConcern ? (
              <View className="mt-6 rounded-sm border border-gold-deep/40 bg-gold-deep/5 px-4 py-3">
                <Text className="text-sm text-ink">{sendConcern}</Text>
                <Text className="mt-1 text-sm text-ink-subtle">Send anyway if that's right.</Text>
              </View>
            ) : null}

            {/* Action toolbar */}
            {hasActions ? (
              <View className="mt-6 gap-3">
                {canSend ? (
                  <View>
                    {showOverride ? (
                      <TextInput
                        value={overrideEmail}
                        onChangeText={setOverrideEmail}
                        placeholder={detail.contactEmail ?? 'recipient@example.com'}
                        keyboardType="email-address"
                        autoCapitalize="none"
                        className="mb-2 rounded-sm border border-field bg-cream-warm px-3 py-2 text-ink"
                      />
                    ) : null}
                    <View className="flex-row gap-2">
                      <Pressable
                        onPress={onSend}
                        disabled={acting}
                        className="flex-1 rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
                      >
                        <Text className="text-center text-sm font-medium text-cream">
                          {isRevising
                            ? 'Resend corrected invoice'
                            : inv.status === 'sent'
                              ? 'Resend invoice'
                              : 'Send invoice'}
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => setShowOverride((v) => !v)}
                        className="rounded-sm border border-ink/20 px-3 py-3 active:bg-ink/5"
                      >
                        {/* Web spells this out in a dropdown menu item ("Send
                            to a different email"). Compressed to "To…" it read
                            as clipped text rather than a control (TMC-277), so
                            it says what it does at the width available. */}
                        <Text className="font-mono text-xs uppercase tracking-widest text-ink-muted">
                          {showOverride ? 'Cancel' : 'Other email'}
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
                  {canRevise ? (
                    <Pressable
                      onPress={onRevise}
                      disabled={acting}
                      className="flex-1 rounded-sm border border-ink/20 px-4 py-3 active:bg-ink/5 disabled:opacity-50"
                    >
                      <Text className="text-center text-sm font-medium text-ink">
                        Fix this invoice
                      </Text>
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
                    <Text className="text-xs uppercase tracking-widest text-ink-subtle">
                      Mark sent without email
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}

            {/* Mark-paid panel */}
            {canMarkPaid && showPaidPanel ? (
              <View className="mt-4 rounded-sm border border-ink/15 bg-cream-warm p-4">
                <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
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
                      <Text className={paidMethod === m ? 'text-ink' : 'text-ink-muted'}>
                        {PAYMENT_METHOD_LABELS[m]}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                {paidMethod === 'check' || paidMethod === 'other' ? (
                  <View className="mt-3">
                    <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                      {paidMethod === 'check' ? 'Check number' : 'Note'}
                    </Text>
                    <TextInput
                      value={paidReference}
                      onChangeText={setPaidReference}
                      className="mt-1 rounded-sm border border-field bg-cream px-3 py-2 text-ink"
                    />
                  </View>
                ) : null}
                <View className="mt-3">
                  <DateField label="Payment date" value={paidOn} onChange={setPaidOn} />
                  <MoneyAccountPicker
                    accounts={depositAccounts}
                    value={depositAccountId ?? depositAccounts?.[0]?.id ?? null}
                    onChange={setDepositAccountId}
                    label="Deposited into"
                  />
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

            {/* Payments (TMC-187). The prose panel that used to sit here is
                gone: it existed because a draft cannot take a payment and the
                screen said nothing about it, leaving "Mark paid" (which books
                the FULL total) as the only payment-shaped control for someone
                holding a deposit. The form below answers that directly, so
                explaining the state machine is no longer the best we can do. */}

            {/* One question, not a state machine (TMC-199, ported to mobile as
                TMC-271). This box used to be sixty words explaining issue it,
                mark it sent, then record a part-payment. The person reading it
                is standing in a customer's yard holding cash and knows exactly
                one thing: how much. So that is all it asks; issuing happens
                server-side in the same transaction.

                Closing it again matters: someone who opens it to look, and did
                not take a deposit, needs a way back to a quiet screen.

                Not while a correction is in flight (TMC-227): this form issues
                the invoice as a side effect of banking the money, so on a
                pulled-back draft it would silently resend at whatever total it
                currently holds, finishing a correction the user is in the
                middle of with the wrong numbers. */}
            {canWrite && status === 'draft' && !isRevising ? (
              <View className="mt-8 rounded-sm border border-ink/10 bg-cream-warm p-4">
                <Pressable
                  onPress={() => setShowDeposit((v) => !v)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showDeposit }}
                  className="flex-row items-center gap-2"
                >
                  <Text className="text-base text-ink-subtle">{showDeposit ? '▾' : '▸'}</Text>
                  <Text className="font-serif text-lg font-light text-ink">
                    Received a deposit?
                  </Text>
                </Pressable>
                {showDeposit ? (
                  <View className="mt-3">
                    <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                      How much
                    </Text>
                    <TextInput
                      value={depositAmount}
                      onChangeText={setDepositAmount}
                      placeholder={inv.total}
                      keyboardType="decimal-pad"
                      className="mt-1 border-b border-field py-2 text-ink"
                    />
                    <Pressable
                      onPress={onTakeDeposit}
                      disabled={acting}
                      className="mt-3 rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
                    >
                      <Text className="text-center text-sm font-medium text-cream">
                        {acting ? 'Recording…' : 'Record it'}
                      </Text>
                    </Pressable>
                    <Text className="mt-3 text-sm text-ink-subtle">
                      We'll finish the invoice off and log what they paid. You can still send it to
                      them whenever you like.
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}

            {settlement && (settlement.payments.length > 0 || canRecordPayment) ? (
              <View className="mt-8 rounded-sm border border-ink/10 bg-cream-warm p-4">
                <Text className="font-serif text-lg font-light text-ink">Payments</Text>
                <Text className="mt-1 text-sm text-ink-muted">
                  {settlement.settlement === 'overpaid'
                    ? `Overpaid by $${Math.abs(Number(settlement.outstanding)).toFixed(2)}`
                    : settlement.settlement === 'paid'
                      ? 'Paid in full'
                      : `$${Number(settlement.paid).toFixed(2)} of $${Number(inv.total).toFixed(2)} · $${Number(settlement.outstanding).toFixed(2)} still owed`}
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
                      <Text className="mt-0.5 text-xs text-ink-subtle">
                        {p.receivedOn} · {PAYMENT_METHOD_LABELS[p.method] ?? p.method}
                        {p.reference ? ` · ${p.reference}` : ''}
                      </Text>
                    </View>
                    {canRecordPayment ? (
                      <Pressable onPress={() => onRemovePayment(p.id)} disabled={acting}>
                        <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                          Remove
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                ))}

                {canWrite && status !== 'voided' ? (
                  <Pressable
                    onPress={() => onSetReminders(!inv?.remindersOptedOut)}
                    className="mt-4 border-t border-ink/10 pt-3"
                  >
                    <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                      {inv?.remindersOptedOut
                        ? 'Reminders off for this invoice — turn back on'
                        : 'Stop reminding about this invoice'}
                    </Text>
                  </Pressable>
                ) : null}

                {canRecordPayment && !showPaymentPanel ? (
                  <Pressable
                    onPress={() => {
                      setShowPaymentPanel(true);
                      // Pre-fill only when something is genuinely outstanding.
                      // On a settled invoice the balance is "0.00", and handing
                      // that to the user is handing them an amount the API
                      // refuses — a zero-amount receipt is rejected, correctly.
                      // The empty-input guard in onRecordPayment doesn't save
                      // it either, because "0.00" is not empty.
                      //
                      // Reachable before TMC-196 only on an invoice settled
                      // through payment rows; now every mark-paid invoice shows
                      // this button, so it IS the refund path's default state
                      // rather than an edge case (TMC-197).
                      setPayAmount(
                        Number(settlement.outstanding) > 0 ? settlement.outstanding : '',
                      );
                    }}
                    className="mt-4 rounded-sm border border-ink/20 px-4 py-2.5 active:border-gold-deep"
                  >
                    <Text className="text-center font-mono text-xs uppercase tracking-widest text-ink-muted">
                      Record a payment
                    </Text>
                  </Pressable>
                ) : null}

                {canRecordPayment && showPaymentPanel ? (
                  <View className="mt-4 border-t border-ink/10 pt-4">
                    <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                      Amount
                    </Text>
                    <TextInput
                      value={payAmount}
                      onChangeText={setPayAmount}
                      keyboardType="decimal-pad"
                      placeholder="0.00"
                      className="mt-1 rounded-sm border border-field bg-cream px-3 py-2.5 text-ink"
                    />

                    <Text className="mt-4 font-mono text-xs uppercase tracking-widest text-ink-subtle">
                      Date received
                    </Text>
                    <TextInput
                      value={payOn}
                      onChangeText={setPayOn}
                      placeholder="YYYY-MM-DD"
                      autoCapitalize="none"
                      className="mt-1 rounded-sm border border-field bg-cream px-3 py-2.5 text-ink"
                    />

                    <Text className="mt-4 font-mono text-xs uppercase tracking-widest text-ink-subtle">
                      Method
                    </Text>
                    <View className="mt-2 flex-row flex-wrap gap-2">
                      {PAID_METHODS.map((m) => (
                        <Pressable
                          key={m}
                          onPress={() => setPayMethod(m)}
                          className={`rounded-sm border px-3 py-1.5 ${
                            payMethod === m ? 'border-gold-deep bg-ink' : 'border-ink/20'
                          }`}
                        >
                          <Text
                            className={`text-xs ${payMethod === m ? 'text-cream' : 'text-ink-muted'}`}
                          >
                            {PAYMENT_METHOD_LABELS[m] ?? m}
                          </Text>
                        </Pressable>
                      ))}
                    </View>

                    <Text className="mt-4 font-mono text-xs uppercase tracking-widest text-ink-subtle">
                      Type
                    </Text>
                    <View className="mt-2 flex-row gap-2">
                      {(
                        [
                          ['in', 'Payment received'],
                          ['out', 'Refund or credit'],
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
                              payDirection === value ? 'text-cream' : 'text-ink-muted'
                            }`}
                          >
                            {label}
                          </Text>
                        </Pressable>
                      ))}
                    </View>

                    <Text className="mt-4 font-mono text-xs uppercase tracking-widest text-ink-subtle">
                      Reference (optional)
                    </Text>
                    <TextInput
                      value={payReference}
                      onChangeText={setPayReference}
                      placeholder="Check number, confirmation code"
                      className="mt-1 rounded-sm border border-field bg-cream px-3 py-2.5 text-ink"
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
                      <Text className="text-center font-mono text-xs uppercase tracking-widest text-ink-subtle">
                        Cancel
                      </Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            ) : null}

            {/* Share link */}
            {publicUrl ? (
              <Pressable
                onPress={() => shareLink(publicUrl, 'Your invoice')}
                accessibilityRole="button"
                accessibilityLabel="Send the invoice link"
                className="mt-6 rounded-sm border border-ink/10 bg-cream-warm p-4 active:opacity-70"
              >
                <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                  Share link
                </Text>
                <Text selectable className="mt-2 text-sm text-gold-deep">
                  {publicUrl}
                </Text>
                <Text className="mt-2 text-xs text-ink-subtle">
                  Tap to send it. Anyone with this link can view the invoice.
                </Text>
              </Pressable>
            ) : null}

            {/* Meta */}
            <View className="mt-8 gap-2">
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
                    <Text className="mt-0.5 text-[10px] text-ink-subtle">
                      Taxable · {Number(li.taxRatePct)}%
                    </Text>
                  ) : null}
                  <View className="mt-1 flex-row justify-between">
                    <Text className="font-mono text-xs text-ink-subtle">
                      {formatQuantity(li.quantity)}
                      {li.unitLabel ? ` ${li.unitLabel}` : ''} × {formatUnitPrice(li.unitPrice)}
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
                <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
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
      <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">{label}</Text>
      <Text
        className={`text-ink ${mono ? 'font-mono tabular-nums' : ''} ${emphasize ? 'text-lg' : ''}`}
      >
        {value}
      </Text>
    </View>
  );
}
