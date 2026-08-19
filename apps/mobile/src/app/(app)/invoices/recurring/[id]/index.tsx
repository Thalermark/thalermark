import { formatQuantity, formatUnitPrice } from '@thalermark/validation';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type AuditEvent, AuditHistory } from '../../../../../components/AuditHistory';
import { api } from '../../../../../lib/api';
import { useMay } from '../../../../../lib/role';

function cadenceLabel(frequency: string, interval: number): string {
  const unit = frequency === 'weekly' ? 'week' : frequency === 'monthly' ? 'month' : 'year';
  return interval === 1 ? `Every ${unit}` : `Every ${interval} ${unit}s`;
}

// Recurring schedule detail + actions (mirror of apps/web's /recurring/[id]):
// run-now / pause / resume / end gated by RECURRING_TRANSITIONS, plus Edit
// (active|paused only — an ended schedule is terminal/read-only). The
// generated-invoices history list is still deferred.
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
type Schedule = {
  status: string;
  contactId: string;
  frequency: string;
  intervalCount: number;
  startDate: string;
  endDate: string | null;
  maxOccurrences: number | null;
  netTermsDays: number | null;
  nextRunDate: string;
  occurrenceCount: number;
  currency: string;
  subtotal: string;
  tax: string | null;
  total: string;
  notes: string | null;
  lineItems: LineItem[];
};
type DetailState =
  | { state: 'loading' }
  | { state: 'ready'; schedule: Schedule; customerName: string | null }
  | { state: 'error' };

const TRANSITION_ERRORS: Record<string, string> = {
  invalid_transition: 'This schedule can no longer be changed.',
};

export default function RecurringDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [detail, setDetail] = useState<DetailState>({ state: 'loading' });
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [acting, setActing] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [generatedInvoiceId, setGeneratedInvoiceId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api.api['recurring-invoices'][':id'].$get({ param: { id } });
    if (!res.ok) {
      setDetail({ state: 'error' });
      return;
    }
    const s = await res.json();
    let customerName: string | null = null;
    const custRes = await api.api.contacts[':id'].$get({ param: { id: s.contactId } });
    if (custRes.ok) customerName = (await custRes.json()).name;
    setDetail({
      state: 'ready',
      customerName,
      schedule: {
        status: s.status,
        contactId: s.contactId,
        frequency: s.frequency,
        intervalCount: s.intervalCount,
        startDate: s.startDate,
        endDate: s.endDate ?? null,
        maxOccurrences: s.maxOccurrences ?? null,
        netTermsDays: s.netTermsDays ?? null,
        nextRunDate: s.nextRunDate,
        occurrenceCount: s.occurrenceCount,
        currency: s.currency,
        subtotal: s.subtotal,
        tax: s.tax ?? null,
        total: s.total,
        notes: s.notes ?? null,
        lineItems: s.lineItems,
      },
    });
    // Audit trail — best-effort; refetched on every load() (focus + after each
    // pause/resume/end), so the history reflects the action just taken. A
    // failure here must not flip the whole screen to error, hence the swallow.
    try {
      const auditRes = await api.api['audit-events'].$get({
        query: { entityType: 'recurring_invoice', entityId: id },
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

  // Role gate (UX only — the API is authoritative). Recurring state actions are
  // `sales:write`; each status gate is ANDed with it.
  const canWrite = useMay('sales:write');
  const s = detail.state === 'ready' ? detail.schedule : null;
  const status = s?.status;
  const canRunNow = canWrite && status === 'active';
  const canPause = canWrite && status === 'active';
  const canResume = canWrite && status === 'paused';
  const canEnd = canWrite && (status === 'active' || status === 'paused');
  // Edit mirrors the web gate: allowed while non-terminal; the API rejects an
  // edit on an ended schedule (the edit screen also guards on load).
  const canEdit = canWrite && (status === 'active' || status === 'paused');
  const hasActions = canRunNow || canPause || canResume || canEnd;

  const endLabel = s?.endDate
    ? `Ends ${s.endDate}`
    : s?.maxOccurrences
      ? `Ends after ${s.maxOccurrences} invoices`
      : 'Runs until paused or ended';

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

  function onRunNow() {
    act(
      () => api.api['recurring-invoices'][':id']['run-now'].$post({ param: { id } }),
      (body) => {
        const invId = body as { invoiceId?: string; id?: string } | null;
        setGeneratedInvoiceId(invId?.invoiceId ?? invId?.id ?? null);
      },
    );
  }

  function onEnd() {
    Alert.alert('End schedule?', 'This stops all future invoices. It cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'End',
        style: 'destructive',
        onPress: () => act(() => api.api['recurring-invoices'][':id'].end.$post({ param: { id } })),
      },
    ]);
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Text
          onPress={() => router.push('/invoices/recurring')}
          className="font-mono text-xs uppercase tracking-widest text-ink/60"
        >
          ← Repeating
        </Text>

        {detail.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        ) : detail.state === 'error' || !s ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load this schedule.</Text>
        ) : (
          <>
            <View className="mt-3 flex-row items-center justify-between">
              <Text className="font-serif text-3xl font-light text-ink">
                {cadenceLabel(s.frequency, s.intervalCount)}
              </Text>
              <View className="flex-row items-center gap-3">
                {canEdit ? (
                  <Pressable
                    onPress={() => router.push(`/invoices/recurring/${id}/edit`)}
                    className="rounded-sm border border-ink/20 px-3 py-1.5 active:border-gold-deep"
                  >
                    <Text className="font-mono text-xs uppercase tracking-widest text-ink/70">
                      Edit
                    </Text>
                  </Pressable>
                ) : null}
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
                  {s.status}
                </Text>
              </View>
            </View>

            {transitionError ? (
              <View className="mt-4 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
                <Text className="text-sm text-oxblood">{transitionError}</Text>
              </View>
            ) : null}
            {generatedInvoiceId ? (
              <Pressable
                onPress={() => router.push(`/invoices/${generatedInvoiceId}`)}
                className="mt-4 rounded-sm border border-gold-deep/30 bg-gold-deep/5 px-4 py-3"
              >
                <Text className="text-sm text-ink">Generated an invoice — view it →</Text>
              </Pressable>
            ) : null}

            {/* Actions */}
            {hasActions ? (
              <View className="mt-6 gap-3">
                {canRunNow ? (
                  <Pressable
                    onPress={onRunNow}
                    disabled={acting}
                    className="rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
                  >
                    <Text className="text-center text-sm font-medium text-cream">
                      Generate invoice now
                    </Text>
                  </Pressable>
                ) : null}
                <View className="flex-row gap-2">
                  {canPause ? (
                    <Pressable
                      onPress={() =>
                        act(() =>
                          api.api['recurring-invoices'][':id'].pause.$post({ param: { id } }),
                        )
                      }
                      disabled={acting}
                      className="flex-1 rounded-sm border border-ink/20 px-4 py-3 active:bg-ink/5 disabled:opacity-50"
                    >
                      <Text className="text-center text-sm font-medium text-ink">Pause</Text>
                    </Pressable>
                  ) : null}
                  {canResume ? (
                    <Pressable
                      onPress={() =>
                        act(() =>
                          api.api['recurring-invoices'][':id'].resume.$post({ param: { id } }),
                        )
                      }
                      disabled={acting}
                      className="flex-1 rounded-sm border border-ink/20 px-4 py-3 active:bg-ink/5 disabled:opacity-50"
                    >
                      <Text className="text-center text-sm font-medium text-ink">Resume</Text>
                    </Pressable>
                  ) : null}
                  {canEnd ? (
                    <Pressable
                      onPress={onEnd}
                      disabled={acting}
                      className="flex-1 rounded-sm border border-oxblood/30 px-4 py-3 active:bg-oxblood/5 disabled:opacity-50"
                    >
                      <Text className="text-center text-sm font-medium text-oxblood">End</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            ) : null}

            {/* Meta */}
            <View className="mt-8 gap-2">
              <Meta label="Contact" value={detail.customerName ?? '—'} />
              <Meta label="Next run" value={s.status === 'ended' ? '—' : s.nextRunDate} />
              <Meta label="Generated" value={String(s.occurrenceCount)} />
              <Meta label="Schedule" value={endLabel} />
            </View>

            {/* Line items + totals */}
            <View className="mt-8 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
              {s.lineItems.map((li) => (
                <View key={li.position} className="border-b border-ink/10 px-4 py-3">
                  <Text className="text-ink">{li.description}</Text>
                  {li.taxable ? (
                    <Text className="mt-0.5 text-[10px] text-ink/40">
                      Taxable · {Number(li.taxRatePct)}%
                    </Text>
                  ) : null}
                  <View className="mt-1 flex-row justify-between">
                    <Text className="font-mono text-xs text-ink/50">
                      {formatQuantity(li.quantity)}
                      {li.unitLabel ? ` ${li.unitLabel}` : ''} × {formatUnitPrice(li.unitPrice)}
                    </Text>
                    <Text className="font-mono tabular-nums text-ink">{li.amount}</Text>
                  </View>
                </View>
              ))}
              <View className="px-4 py-3">
                <Meta label="Subtotal" value={s.subtotal} mono />
                <View className="mt-1">
                  <Meta label="Tax" value={s.tax ?? '0.00'} mono />
                </View>
                <View className="mt-2 border-t border-ink/10 pt-2">
                  <Meta label="Total" value={`${s.currency} ${s.total}`} mono emphasize />
                </View>
              </View>
            </View>

            {s.notes ? (
              <View className="mt-6">
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                  Notes
                </Text>
                <Text className="mt-1 text-ink/80">{s.notes}</Text>
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
