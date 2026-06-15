import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type AuditEvent, AuditHistory } from '../../../../../components/AuditHistory';
import { api } from '../../../../../lib/api';
import { useMay } from '../../../../../lib/role';

// Mirror of apps/web's /settings/tax-policies/[id]. Edit + archive/restore + the
// per-entity audit trail. Lines already taxed under a policy keep their rate
// snapshot when it's archived.
type Policy = {
  name: string;
  ratePct: string;
  isDefault: boolean;
  archivedAt: string | null;
};
type DetailState = { state: 'loading' } | { state: 'ready'; policy: Policy } | { state: 'error' };

const rate = (s: string) => `${Number(s)}%`;

export default function TaxPolicyDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [detail, setDetail] = useState<DetailState>({ state: 'loading' });
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    (active: () => boolean) => {
      api.api['tax-policies'][':id']
        .$get({ param: { id } })
        .then(async (res) => {
          if (!active()) return;
          if (!res.ok) {
            setDetail({ state: 'error' });
            return;
          }
          const p = await res.json();
          setDetail({
            state: 'ready',
            policy: {
              name: p.name,
              ratePct: p.ratePct,
              isDefault: p.isDefault,
              archivedAt: p.archivedAt ?? null,
            },
          });
        })
        .catch(() => {
          if (active()) setDetail({ state: 'error' });
        });
      api.api['audit-events']
        .$get({ query: { entityType: 'tax_policy', entityId: id } })
        .then(async (res) => {
          if (active() && res.ok) setAuditEvents((await res.json()).events);
        })
        .catch(() => {});
    },
    [id],
  );

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      load(() => alive);
      return () => {
        alive = false;
      };
    }, [load]),
  );

  const canManage = useMay('settings:manage');
  const policy = detail.state === 'ready' ? detail.policy : null;
  const archived = policy?.archivedAt != null;

  async function toggleArchive() {
    if (!policy) return;
    setBusy(true);
    try {
      const res = archived
        ? await api.api['tax-policies'][':id'].restore.$post({ param: { id } })
        : await api.api['tax-policies'][':id'].archive.$post({ param: { id } });
      if (res.ok) load(() => true);
    } catch {
      // A focus refetch will reconcile.
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Pressable onPress={() => router.push('/more/tax-policies')}>
          <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
            ← Tax policies
          </Text>
        </Pressable>

        {detail.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        ) : detail.state === 'error' || !policy ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load this tax policy.</Text>
        ) : (
          <>
            <View className="mt-3 flex-row flex-wrap items-center gap-2">
              <Text className="font-serif text-3xl font-light text-ink">{policy.name}</Text>
              {policy.isDefault ? (
                <Text className="rounded-sm border border-gold-deep/40 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-widest text-gold-deep">
                  Default
                </Text>
              ) : null}
              {archived ? (
                <Text className="rounded-sm border border-ink/15 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-widest text-ink/50">
                  Archived
                </Text>
              ) : null}
            </View>

            {canManage ? (
              <View className="mt-4 flex-row gap-2">
                <Pressable
                  onPress={() => router.push(`/more/tax-policies/${id}/edit`)}
                  className="rounded-sm border border-ink/20 px-3 py-1.5 active:border-gold-deep"
                >
                  <Text className="font-mono text-xs uppercase tracking-widest text-ink/70">
                    Edit
                  </Text>
                </Pressable>
                <Pressable
                  onPress={toggleArchive}
                  disabled={busy}
                  className="rounded-sm border border-ink/20 px-3 py-1.5 active:border-gold-deep disabled:opacity-50"
                >
                  <Text className="font-mono text-xs uppercase tracking-widest text-ink/70">
                    {archived ? 'Restore' : 'Archive'}
                  </Text>
                </Pressable>
              </View>
            ) : null}

            {archived ? (
              <Text className="mt-6 rounded-sm border border-ink/15 bg-cream-warm px-4 py-3 text-sm text-ink/70">
                This policy is archived — it won't appear in the tax pickers. Lines already taxed
                under it keep their rate.
              </Text>
            ) : null}

            <View className="mt-8 space-y-6">
              <DetailRow label="Rate" value={rate(policy.ratePct)} />
              <DetailRow label="Default" value={policy.isDefault ? 'Yes' : 'No'} />
            </View>

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
      <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">{label}</Text>
      <Text className="mt-1 text-ink">{value}</Text>
    </View>
  );
}
