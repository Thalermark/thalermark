import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';
import { useMay } from '../../../lib/role';
import { getLedgerAirlockDismissed, setLedgerAirlockDismissed } from '../../../lib/secure-store';
import { pageQuery, usePaginatedList } from '../../../lib/use-paginated-list';

// Mirror of apps/web's /ledger. The gated manual-adjustment portal: balanced
// debit/credit journal entries the user posts as their accountant dictates.
// Unlike the rest of the app the double-entry is shown on purpose here — so the
// list is fronted by an AIRLOCK warning that keeps accounting vocabulary behind
// a deliberate door. Account-scoped list (not company-scoped) like the other
// mobile lists.
type EntryRow = {
  id: string;
  postedAt: string;
  memo: string | null;
  amount: string;
  reversed: boolean;
};

// Acknowledged-this-session flag (module scope) so navigating list → new →
// back doesn't re-prompt; a permanent "don't show again" lives in SecureStore.
let sessionAcknowledged = false;

export default function LedgerIndex() {
  const [phase, setPhase] = useState<'checking' | 'airlock' | 'open'>(
    sessionAcknowledged ? 'open' : 'checking',
  );
  const [dontShowAgain, setDontShowAgain] = useState(false);

  useEffect(() => {
    if (sessionAcknowledged) return;
    let active = true;
    getLedgerAirlockDismissed()
      .then((dismissed) => {
        if (!active) return;
        if (dismissed) {
          sessionAcknowledged = true;
          setPhase('open');
        } else {
          setPhase('airlock');
        }
      })
      .catch(() => active && setPhase('airlock'));
    return () => {
      active = false;
    };
  }, []);

  function enter() {
    sessionAcknowledged = true;
    if (dontShowAgain) setLedgerAirlockDismissed().catch(() => {});
    setPhase('open');
  }

  if (phase === 'checking') {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-cream" edges={['top']}>
        <ActivityIndicator color="#0f1626" />
      </SafeAreaView>
    );
  }
  if (phase === 'airlock') {
    return (
      <Airlock dontShowAgain={dontShowAgain} setDontShowAgain={setDontShowAgain} onEnter={enter} />
    );
  }
  return <EntryList />;
}

function Airlock({
  dontShowAgain,
  setDontShowAgain,
  onEnter,
}: {
  dontShowAgain: boolean;
  setDontShowAgain: (v: boolean) => void;
  onEnter: () => void;
}) {
  const router = useRouter();
  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="flex-1 justify-center px-6 pb-16">
        <View className="rounded-sm border border-ink/15 bg-cream-warm p-6">
          <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
            The Ledger
          </Text>
          <Text className="mt-3 font-serif text-2xl font-light text-ink">
            The accounting layer under your books.
          </Text>
          <Text className="mt-4 text-sm leading-relaxed text-ink-muted">
            This is for adjustments your accountant tells you to make — debits, credits, and journal
            entries. Most people never need it. Everything you do day-to-day — invoices, expenses,
            getting paid — lives in the plain part of the app; this is the one place the raw
            accounting shows through.
          </Text>
          <Pressable
            onPress={() => setDontShowAgain(!dontShowAgain)}
            className="mt-6 flex-row items-center gap-2"
          >
            <Ionicons
              name={dontShowAgain ? 'checkbox' : 'square-outline'}
              size={20}
              color="#9a7b4f"
            />
            <Text className="text-sm text-ink-muted">Don't show this again</Text>
          </Pressable>
          <View className="mt-6 flex-row items-center gap-3">
            <Pressable
              onPress={onEnter}
              className="rounded-sm bg-ink px-5 py-3 active:bg-gold-deep"
            >
              <Text className="text-sm font-medium text-cream">Continue</Text>
            </Pressable>
            <Pressable onPress={() => router.back()} className="px-3 py-3">
              <Text className="text-sm text-ink-subtle">Go back</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function EntryList() {
  const router = useRouter();
  const canAdjust = useMay('ledger:adjust');

  const fetchPage = useCallback(async (cursor: string | null) => {
    const res = await api.api.ledger.entries.$get({ query: pageQuery(cursor) });
    if (!res.ok) return null;
    const { entries, nextCursor } = await res.json();
    return {
      rows: entries.map(
        (e): EntryRow => ({
          id: e.id,
          postedAt: e.postedAt,
          memo: e.memo,
          amount: e.amount,
          reversed: e.reversed,
        }),
      ),
      nextCursor,
    };
  }, []);

  const { list, loadingMore, loadMore } = usePaginatedList(fetchPage);

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <View className="flex-row items-end justify-between px-6 pt-6">
        <View>
          <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
            The Ledger
          </Text>
          <Text className="mt-2 font-serif text-3xl font-light text-ink">Journal entries</Text>
        </View>
        {canAdjust ? (
          <Pressable
            onPress={() => router.push('/ledger/new')}
            className="rounded-sm bg-ink px-4 py-2 active:bg-gold-deep"
          >
            <Text className="text-sm font-medium text-cream">+ New</Text>
          </Pressable>
        ) : null}
      </View>

      <Pressable onPress={() => router.push('/ledger/close')} className="px-6 pt-3">
        <Text className="text-sm text-gold-deep">Close out a year →</Text>
      </Pressable>

      {list.state === 'loading' ? (
        <View className="mt-12 items-center">
          <ActivityIndicator color="#0f1626" />
        </View>
      ) : list.state === 'error' ? (
        <Text className="mt-8 px-6 text-sm text-oxblood">Couldn't load this.</Text>
      ) : list.rows.length === 0 ? (
        <Text className="mt-8 px-6 text-ink-muted">No manual entries yet.</Text>
      ) : (
        <FlatList
          data={list.rows}
          keyExtractor={(e) => e.id}
          className="mt-6"
          contentContainerClassName="px-6 pb-6"
          ItemSeparatorComponent={() => <View className="h-px bg-ink/10" />}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingMore ? (
              <View className="py-4">
                <ActivityIndicator color="#0f1626" />
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push(`/ledger/${item.id}`)}
              className="bg-cream-warm px-5 py-4 active:bg-cream"
            >
              <View className="flex-row items-center justify-between">
                <Text className="flex-1 pr-3 font-serif text-lg text-ink" numberOfLines={1}>
                  {item.memo ?? 'Journal entry'}
                </Text>
                <Text className="font-mono tabular-nums text-ink">{item.amount}</Text>
              </View>
              <View className="mt-1 flex-row items-center justify-between">
                <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                  {item.postedAt.slice(0, 10)}
                </Text>
                {item.reversed ? (
                  <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                    Reversed
                  </Text>
                ) : null}
              </View>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}
