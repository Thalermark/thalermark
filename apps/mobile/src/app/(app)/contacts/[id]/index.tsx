import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type AuditEvent, AuditHistory } from '../../../../components/AuditHistory';
import { api } from '../../../../lib/api';
import { useMay } from '../../../../lib/role';

// Mirror of the basic-fields half of apps/web's /contacts/[id], plus the
// per-entity audit trail (M11e) and the late-payer "payment reliability"
// sidebar (the same deterministic API figures + headline/tone the web page
// derives — no LLM).
type Contact = {
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
  archivedAt: string | null;
};
type Reliability = {
  paidCount: number;
  lateCount: number;
  onTimeCount: number;
  latePct: number | null;
  avgDaysLate: number | null;
  overdueCount: number;
  overdueTotal: string;
};
type DetailState = { state: 'loading' } | { state: 'ready'; contact: Contact } | { state: 'error' };

const fmt = (s: string) =>
  Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// Headline + tone from the reliability figures, ported verbatim from web's
// /contacts/[id]. Needs >= 2 paid invoices to state a pattern; below that we
// only surface a live overdue warning, if any.
function deriveReliability(
  r: Reliability | null,
): { headline: string; tone: 'warning' | 'good' | 'info' } | null {
  if (!r) return null;
  const overdue =
    r.overdueCount > 0
      ? `${r.overdueCount} invoice${r.overdueCount === 1 ? '' : 's'} overdue now (${fmt(r.overdueTotal)})`
      : null;
  if (r.paidCount < 2) {
    return overdue ? { headline: overdue, tone: 'warning' } : null;
  }
  if (r.lateCount === 0) {
    return { headline: `Always pays on time (${r.paidCount} invoices)`, tone: 'good' };
  }
  const days =
    r.avgDaysLate && r.avgDaysLate > 0
      ? ` — about ${r.avgDaysLate} ${r.avgDaysLate === 1 ? 'day' : 'days'} past due`
      : '';
  return {
    headline: `Pays late ${r.lateCount} of ${r.paidCount} times${days}`,
    tone: (r.latePct ?? 0) >= 50 ? 'warning' : 'info',
  };
}

const toneClass = (tone: 'warning' | 'good' | 'info') =>
  tone === 'warning'
    ? 'border-oxblood/30 bg-oxblood/5'
    : tone === 'good'
      ? 'border-gold-deep/30 bg-gold-deep/5'
      : 'border-ink/15 bg-cream-warm';

export default function ContactDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [detail, setDetail] = useState<DetailState>({ state: 'loading' });
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [reliability, setReliability] = useState<Reliability | null>(null);
  const [busy, setBusy] = useState(false);

  // One loader, called on focus and again after archive/restore — the same
  // shape the items detail screen uses. `active` is a getter rather than a
  // captured boolean so an unmount mid-flight still cancels the setState.
  const load = useCallback(
    (active: () => boolean) => {
      api.api.contacts[':id']
        .$get({ param: { id } })
        .then(async (res) => {
          if (!active()) return;
          if (!res.ok) {
            setDetail({ state: 'error' });
            return;
          }
          const c = await res.json();
          setDetail({
            state: 'ready',
            contact: {
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
              archivedAt: c.archivedAt ?? null,
            },
          });
        })
        .catch(() => {
          if (active()) setDetail({ state: 'error' });
        });
      // Audit trail — best-effort sidebar; refetched on every load() (focus +
      // after archive/restore) so the new entry shows without a manual back-and-
      // forth. A non-OK response degrades to an empty list.
      api.api['audit-events']
        .$get({ query: { entityType: 'contact', entityId: id } })
        .then(async (res) => {
          if (active() && res.ok) setAuditEvents((await res.json()).events);
        })
        .catch(() => {});
      // Payment reliability — best-effort, same degrade-to-null contract.
      api.api.contacts[':id']['payment-reliability']
        .$get({ param: { id } })
        .then(async (res) => {
          if (active() && res.ok) setReliability(await res.json());
        })
        .catch(() => {});
    },
    [id],
  );

  // Refetch on focus so an edit on the child screen shows on return.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      load(() => alive);
      return () => {
        alive = false;
      };
    }, [load]),
  );

  // Role gate (UX only — the API is authoritative). Editing a contact is
  // `contacts:write`.
  const canWrite = useMay('contacts:write');
  const c = detail.state === 'ready' ? detail.contact : null;
  const archived = c?.archivedAt != null;

  // Archive, never delete: an invoice keeps naming who it was billed to, so a
  // contact with history cannot go away. This only takes the name out of the
  // pickers (TMC-232), and the button that replaces it puts it back.
  async function toggleArchive() {
    if (!c) return;
    setBusy(true);
    try {
      const res = archived
        ? await api.api.contacts[':id'].restore.$post({ param: { id } })
        : await api.api.contacts[':id'].archive.$post({ param: { id } });
      if (res.ok) load(() => true);
    } catch {
      // A focus refetch will reconcile.
    } finally {
      setBusy(false);
    }
  }
  const reliabilityView = deriveReliability(reliability);
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
          onPress={() => router.push('/contacts')}
          className="font-mono text-xs uppercase tracking-widest text-ink-subtle"
        >
          ← Contacts
        </Text>

        {detail.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator className="text-ink" />
          </View>
        ) : detail.state === 'error' || !c ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load this contact.</Text>
        ) : (
          <>
            <View className="mt-3 flex-row items-start justify-between gap-3">
              <View className="flex-1 flex-row flex-wrap items-center gap-2">
                <Text className="font-serif text-3xl font-light text-ink">{c.name}</Text>
                {archived ? (
                  <Text className="rounded-sm border border-ink/15 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-widest text-ink-subtle">
                    Archived
                  </Text>
                ) : null}
              </View>
            </View>

            {/* Statement is a READ, so it sits outside the canWrite gate — a
                read-only member can still answer "what do they owe me" while
                standing in front of the customer. Edit/Archive stay gated. */}
            <View className="mt-4 flex-row flex-wrap gap-2">
              <Pressable
                onPress={() => router.push(`/contacts/${id}/statement`)}
                className="rounded-sm border border-ink/20 px-3 py-1.5 active:border-gold-deep"
              >
                <Text className="font-mono text-xs uppercase tracking-widest text-ink-muted">
                  Statement
                </Text>
              </Pressable>
              {canWrite ? (
                <>
                  <Pressable
                    onPress={() => router.push(`/contacts/${id}/edit`)}
                    className="rounded-sm border border-ink/20 px-3 py-1.5 active:border-gold-deep"
                  >
                    <Text className="font-mono text-xs uppercase tracking-widest text-ink-muted">
                      Edit
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={toggleArchive}
                    disabled={busy}
                    className="rounded-sm border border-ink/20 px-3 py-1.5 active:border-gold-deep disabled:opacity-50"
                  >
                    <Text className="font-mono text-xs uppercase tracking-widest text-ink-muted">
                      {archived ? 'Restore' : 'Archive'}
                    </Text>
                  </Pressable>
                </>
              ) : null}
            </View>

            {archived ? (
              <Text className="mt-6 rounded-sm border border-ink/15 bg-cream-warm px-4 py-3 text-sm text-ink-muted">
                Archived — hidden from the customer and vendor pickers. Existing invoices, estimates
                and expenses are untouched and still name them.
              </Text>
            ) : null}

            <View className="mt-8 gap-6">
              {c.email ? <DetailRow label="Email" value={c.email} /> : null}
              {c.phone ? <DetailRow label="Phone" value={c.phone} /> : null}
              {addressLines.length > 0 ? (
                <View>
                  <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
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
            {reliabilityView ? (
              <View className="mt-8">
                <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                  Payment reliability
                </Text>
                <View
                  className={`mt-3 rounded-sm border px-4 py-3 ${toneClass(reliabilityView.tone)}`}
                >
                  <Text className="text-sm text-ink/80">{reliabilityView.headline}</Text>
                </View>
                {reliability && reliability.paidCount >= 2 && reliability.overdueCount > 0 ? (
                  <View className="mt-2 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
                    <Text className="text-sm text-ink/80">
                      {reliability.overdueCount} invoice{reliability.overdueCount === 1 ? '' : 's'}{' '}
                      overdue now ({fmt(reliability.overdueTotal)})
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}
            <AuditHistory events={auditEvents} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">{label}</Text>
      <Text className="mt-1 text-ink">{value}</Text>
    </View>
  );
}
