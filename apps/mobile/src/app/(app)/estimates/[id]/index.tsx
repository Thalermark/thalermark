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
import { api } from '../../../../lib/api';
import { useMay } from '../../../../lib/role';
import { getServerUrl } from '../../../../lib/server-url';

// Estimate detail + actions (mirror of apps/web's /estimates/[id]):
// mark-sent / mark-accepted / mark-declined / send / convert-to-invoice. No
// payment semantics (estimates aren't a debt). Edit is draft-only (M11c);
// duplicate deferred.
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
type Estimate = {
  status: string;
  number: string;
  contactId: string;
  issueDate: string;
  expiresOn: string | null;
  currency: string;
  subtotal: string;
  tax: string | null;
  total: string;
  notes: string | null;
  // Needed for the derived "being revised" state: 'draft' with a sent_at is an
  // estimate pulled back to be corrected (TMC-227).
  sentAt: string | null;
  publicToken: string | null;
  convertedInvoiceId: string | null;
  lineItems: LineItem[];
  revisions: { revisedAt: string; previousTotal: string }[];
};
type DetailState =
  | { state: 'loading' }
  | {
      state: 'ready';
      estimate: Estimate;
      customerName: string | null;
      contactEmail: string | null;
    }
  | { state: 'error' };

const TRANSITION_ERRORS: Record<string, string> = {
  invalid_transition: 'This estimate can no longer be changed.',
  invalid_recipient: 'Add a contact email or enter one to send.',
  email_not_configured: "Email isn't configured on this server.",
  contact_not_found: 'The contact for this estimate no longer exists.',
  // Correcting a sent estimate (TMC-227).
  already_converted: 'This estimate already became an invoice. Fix the invoice instead.',
};

const todayIso = () => new Date().toISOString().slice(0, 10);

export default function EstimateDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [detail, setDetail] = useState<DetailState>({ state: 'loading' });
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [acting, setActing] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  // Whether the email actually left the building. The console mailer logs the
  // message and resolves, which is indistinguishable from a real send — so the
  // server says, and this screen stops claiming a delivery it can't vouch for
  // (TMC-212). Defaults to true: an older API omits `delivered`, and that
  // silence must not raise a warning.
  const [sendDelivered, setSendDelivered] = useState(true);
  const [showOverride, setShowOverride] = useState(false);
  const [overrideEmail, setOverrideEmail] = useState('');

  const load = useCallback(async () => {
    const res = await api.api.estimates[':id'].$get({ param: { id } });
    if (!res.ok) {
      setDetail({ state: 'error' });
      return;
    }
    const est = await res.json();
    let customerName: string | null = null;
    let contactEmail: string | null = null;
    const custRes = await api.api.contacts[':id'].$get({ param: { id: est.contactId } });
    if (custRes.ok) {
      const c = await custRes.json();
      customerName = c.name;
      contactEmail = c.email ?? null;
    }
    setDetail({
      state: 'ready',
      customerName,
      contactEmail,
      estimate: {
        status: est.status,
        number: est.number,
        contactId: est.contactId,
        issueDate: est.issueDate,
        expiresOn: est.expiresOn ?? null,
        currency: est.currency,
        subtotal: est.subtotal,
        tax: est.tax ?? null,
        total: est.total,
        notes: est.notes ?? null,
        sentAt: est.sentAt ?? null,
        publicToken: est.publicToken ?? null,
        convertedInvoiceId: est.convertedInvoiceId ?? null,
        lineItems: est.lineItems,
        revisions: est.revisions ?? [],
      },
    });
    // Audit trail — best-effort; refetched on every load() (focus + after each
    // transition), so the history reflects the action just taken. A failure
    // here must not flip the whole screen to error, hence the swallow.
    try {
      const auditRes = await api.api['audit-events'].$get({
        query: { entityType: 'estimate', entityId: id },
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

  // Role gate (UX only — the API is authoritative). Every estimate write and
  // state action is `sales:write`; each status gate is ANDed with it.
  const canWrite = useMay('sales:write');
  const est = detail.state === 'ready' ? detail.estimate : null;
  const status = est?.status;
  const canSend = canWrite && (status === 'draft' || status === 'sent');
  const canMarkSent = canWrite && status === 'draft';
  const canMarkAccepted = canWrite && (status === 'draft' || status === 'sent');
  const canMarkDeclined = canWrite && (status === 'draft' || status === 'sent');
  const canConvert = canWrite && status === 'accepted' && est?.convertedInvoiceId == null;
  const canEdit = canWrite && status === 'draft';
  // Pulled back to be corrected and not yet resent (TMC-227) — derived, like
  // expiredNotice below, never a stored status. Not offered once converted: by
  // then the invoice is the document that is wrong.
  const isRevising = status === 'draft' && est?.sentAt != null;
  const statusLabel = isRevising ? 'being revised' : status;
  const pulledBackOn = est?.revisions?.[0]?.revisedAt
    ? ` on ${est.revisions[0].revisedAt.slice(0, 10)}`
    : '';
  const canRevise = canWrite && status === 'sent' && est?.convertedInvoiceId == null;
  const hasActions =
    canSend || canMarkSent || canRevise || canMarkAccepted || canMarkDeclined || canConvert;
  const expiredNotice =
    status === 'sent' && est?.expiresOn != null && est.expiresOn < todayIso()
      ? est.expiresOn
      : null;

  async function act(
    fn: () => Promise<{ ok: boolean; json: () => Promise<unknown> }>,
    onOk?: (body: unknown) => void,
  ) {
    setActing(true);
    setTransitionError(null);
    try {
      const res = await fn();
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const code = (body as { error?: string } | null)?.error ?? '';
        setTransitionError(TRANSITION_ERRORS[code] ?? code ?? 'Action failed.');
        return;
      }
      onOk?.(body);
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
      () => api.api.estimates[':id'].send.$post({ param: { id }, json: to ? { to } : {} }),
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

  // Duplicate-as-template — clone into a fresh draft (server carries the line
  // sourceItemIds forward) and land on its edit screen. Any status.
  async function onDuplicate() {
    setDuplicating(true);
    setTransitionError(null);
    try {
      const res = await api.api.estimates[':id'].duplicate.$post({ param: { id } });
      if (!res.ok) {
        setTransitionError('Could not duplicate this estimate.');
        return;
      }
      const { id: newId } = await res.json();
      router.push(`/estimates/${newId}/edit`);
    } catch {
      setTransitionError('Could not duplicate this estimate.');
    } finally {
      setDuplicating(false);
    }
  }

  // "Fix this estimate" (TMC-227). Confirmed but not destructive — what the
  // dialog exists for is that the CUSTOMER sees the withdrawal. Same copy as
  // the web detail page.
  function onRevise() {
    Alert.alert(
      'Fix this estimate?',
      "It goes back to a draft you can edit. The customer's link will say it's being revised and they won't be able to accept it until you resend it.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Pull it back',
          onPress: () => act(() => api.api.estimates[':id'].revise.$post({ param: { id } })),
        },
      ],
    );
  }

  function onConvert() {
    act(
      () => api.api.estimates[':id'].convert.$post({ param: { id } }),
      (body) => {
        const invId = (body as { id?: string } | null)?.id;
        if (invId) router.replace(`/invoices/${invId}`);
      },
    );
  }

  const publicUrl = est?.publicToken ? `${getServerUrl()}/i/${est.publicToken}` : null;

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16" keyboardShouldPersistTaps="handled">
        <Text
          onPress={() => router.push('/estimates')}
          className="font-mono text-xs uppercase tracking-widest text-ink/60"
        >
          ← Estimates
        </Text>

        {detail.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        ) : detail.state === 'error' || !est ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load this estimate.</Text>
        ) : (
          <>
            <View className="mt-3 flex-row items-center justify-between">
              <Text className="font-serif text-3xl font-light text-ink">{est.number}</Text>
              <View className="flex-row items-center gap-3">
                {canEdit ? (
                  <Pressable
                    onPress={() => router.push(`/estimates/${id}/edit`)}
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
                  {statusLabel}
                </Text>
              </View>
            </View>

            {isRevising ? (
              /* The stranded-draft nudge (TMC-227) — a correction stopped after
                 the edit leaves a customer holding a quote they cannot accept. */
              <View className="mt-4 rounded-sm border border-gold-deep/40 bg-gold-deep/5 px-4 py-3">
                {/* One interpolated string — JSX strips each line's edge
                    whitespace, which ran the date into the words either side. */}
                <Text className="text-sm text-ink">
                  {`You pulled this back${pulledBackOn} — the customer's link says it's being revised, and they can't accept it, until you resend the corrected estimate.`}
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
                    . This server has no email set up, so nothing reached {sentTo}. The estimate is
                    saved and its share link works; send the customer that link yourself.
                  </Text>
                </View>
              )
            ) : null}
            {expiredNotice ? (
              <View className="mt-4 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
                <Text className="text-sm text-ink">
                  This estimate's validity expired on{' '}
                  <Text className="font-medium">{expiredNotice}</Text>.
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
                          {isRevising
                            ? 'Resend corrected estimate'
                            : est.status === 'sent'
                              ? 'Resend estimate'
                              : 'Send estimate'}
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

                {canMarkAccepted || canMarkDeclined ? (
                  <View className="flex-row gap-2">
                    {canMarkAccepted ? (
                      <Pressable
                        onPress={() =>
                          act(() =>
                            api.api.estimates[':id']['mark-accepted'].$post({ param: { id } }),
                          )
                        }
                        disabled={acting}
                        className="flex-1 rounded-sm border border-ink/20 px-4 py-3 active:bg-ink/5 disabled:opacity-50"
                      >
                        <Text className="text-center text-sm font-medium text-ink">
                          Mark accepted
                        </Text>
                      </Pressable>
                    ) : null}
                    {canMarkDeclined ? (
                      <Pressable
                        onPress={() =>
                          act(() =>
                            api.api.estimates[':id']['mark-declined'].$post({ param: { id } }),
                          )
                        }
                        disabled={acting}
                        className="flex-1 rounded-sm border border-oxblood/30 px-4 py-3 active:bg-oxblood/5 disabled:opacity-50"
                      >
                        <Text className="text-center text-sm font-medium text-oxblood">
                          Decline
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}

                {canRevise ? (
                  <Pressable
                    onPress={onRevise}
                    disabled={acting}
                    className="rounded-sm border border-ink/20 px-4 py-3 active:bg-ink/5 disabled:opacity-50"
                  >
                    <Text className="text-center text-sm font-medium text-ink">
                      Fix this estimate
                    </Text>
                  </Pressable>
                ) : null}

                {canConvert ? (
                  <Pressable
                    onPress={onConvert}
                    disabled={acting}
                    className="rounded-sm bg-gold-deep px-4 py-3 active:opacity-80 disabled:opacity-50"
                  >
                    <Text className="text-center text-sm font-medium text-cream">
                      Convert to invoice
                    </Text>
                  </Pressable>
                ) : null}

                {canMarkSent ? (
                  <Pressable
                    onPress={() =>
                      act(() => api.api.estimates[':id']['mark-sent'].$post({ param: { id } }))
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

            {/* Converted-to link */}
            {est.convertedInvoiceId ? (
              <Pressable
                onPress={() => router.replace(`/invoices/${est.convertedInvoiceId}`)}
                className="mt-6 rounded-sm border border-gold-deep/30 bg-gold-deep/5 px-4 py-3"
              >
                <Text className="text-sm text-ink">Converted to an invoice — view it →</Text>
              </Pressable>
            ) : null}

            {/* Share link */}
            {publicUrl ? (
              <View className="mt-6 rounded-sm border border-ink/10 bg-cream-warm p-4">
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                  Share link
                </Text>
                <Text className="mt-2 text-sm text-gold-deep">{publicUrl}</Text>
                <Text className="mt-2 text-xs text-ink/50">
                  Anyone with this link can view the estimate.
                </Text>
              </View>
            ) : null}

            {/* Meta */}
            <View className="mt-8 space-y-2">
              <Meta label="Contact" value={detail.customerName ?? '—'} />
              <Meta label="Issued" value={est.issueDate} />
              {est.expiresOn ? <Meta label="Valid until" value={est.expiresOn} /> : null}
            </View>

            {/* Line items + totals */}
            <View className="mt-8 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
              {est.lineItems.map((li) => (
                <View key={li.position} className="border-b border-ink/10 px-4 py-3">
                  <Text className="text-ink">{li.description}</Text>
                  {li.taxable ? (
                    <Text className="mt-0.5 text-[10px] text-ink/40">
                      Taxable · {Number(li.taxRatePct)}%
                    </Text>
                  ) : null}
                  <View className="mt-1 flex-row justify-between">
                    <Text className="font-mono text-xs text-ink/50">
                      {String(Number(li.quantity))}
                      {li.unitLabel ? ` ${li.unitLabel}` : ''} × {formatUnitPrice(li.unitPrice)}
                    </Text>
                    <Text className="font-mono tabular-nums text-ink">{li.amount}</Text>
                  </View>
                </View>
              ))}
              <View className="px-4 py-3">
                <Meta label="Subtotal" value={est.subtotal} mono />
                <View className="mt-1">
                  <Meta label="Tax" value={est.tax ?? '0.00'} mono />
                </View>
                <View className="mt-2 border-t border-ink/10 pt-2">
                  <Meta label="Total" value={`${est.currency} ${est.total}`} mono emphasize />
                </View>
              </View>
            </View>

            {est.notes ? (
              <View className="mt-6">
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                  Notes
                </Text>
                <Text className="mt-1 text-ink/80">{est.notes}</Text>
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
