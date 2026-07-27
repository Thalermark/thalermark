import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { pickActiveCompany } from '../../../lib/active-company';
import { api } from '../../../lib/api';
import { useMay } from '../../../lib/role';

// Mirror of apps/web's /ledger/close — the year-end close (TMC-159). Reached
// from inside The Ledger, so it sits behind the same airlock the portal already
// puts in front of accounting vocabulary. The copy stays plain regardless: the
// user reads "close out 2025", never "closing entries".

// How many finished years back to offer, matching web.
const YEARS_OFFERED = 4;

type Closable = {
  fiscalYear: number;
  netIncome: string;
  withdrawals: string;
  equityLabel: string;
  empty: boolean;
};

type ClosedRow = {
  id: string;
  fiscalYear: number;
  netIncome: string;
  closedAt: string;
};

const money = (s: string) =>
  Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export default function LedgerClose() {
  const router = useRouter();
  const canAdjust = useMay('ledger:adjust');

  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [closable, setClosable] = useState<Closable[]>([]);
  const [closes, setCloses] = useState<ClosedRow[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const compRes = await api.api.companies.$get();
      if (!compRes.ok) return setState('error');
      const company = await pickActiveCompany((await compRes.json()).companies);
      if (!company) return setState('error');
      setCompanyId(company.id);

      const closesRes = await api.api.ledger['period-closes'].$get({
        query: { companyId: company.id },
      });
      if (!closesRes.ok) return setState('error');
      const { closes: rows } = await closesRes.json();
      setCloses(
        rows.map((c) => ({
          id: c.id,
          fiscalYear: c.fiscalYear,
          netIncome: c.netIncome,
          closedAt: c.closedAt.slice(0, 10),
        })),
      );

      // Only years that are over and not already covered by a close are worth
      // previewing — a later closed year locks the earlier ones.
      const closedYears = new Set(rows.map((c) => c.fiscalYear));
      const newestClosed = rows.length > 0 ? Math.max(...rows.map((c) => c.fiscalYear)) : null;
      const lastFinished = new Date().getFullYear() - 1;

      const candidates: number[] = [];
      for (let y = lastFinished; y > lastFinished - YEARS_OFFERED; y--) {
        if (closedYears.has(y)) continue;
        if (newestClosed !== null && y < newestClosed) continue;
        candidates.push(y);
      }

      const previews = await Promise.all(
        candidates.map(async (fiscalYear): Promise<Closable | null> => {
          const res = await api.api.ledger['period-closes'].preview.$get({
            query: { companyId: company.id, fiscalYear: String(fiscalYear) },
          });
          if (!res.ok) return null;
          const p = await res.json();
          return {
            fiscalYear,
            netIncome: p.netIncome,
            withdrawals: p.withdrawals,
            equityLabel: p.equityLabel,
            empty: p.empty,
          };
        }),
      );
      setClosable(previews.filter((p): p is Closable => p !== null));
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // Closing is a deliberate act, so it goes through a confirm — the same beat
  // the web page gets from its expand-then-confirm panel.
  function confirmClose(year: Closable) {
    Alert.alert(
      `Close out ${year.fiscalYear}?`,
      `This locks ${year.fiscalYear} so nothing can change it, and moves the year's ${
        Number(year.netIncome) < 0 ? 'loss' : 'profit'
      } into ${year.equityLabel.toLowerCase()}. You can re-open it here later if you need to.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: `Close ${year.fiscalYear}`, onPress: () => doClose(year.fiscalYear) },
      ],
    );
  }

  async function doClose(fiscalYear: number) {
    if (!companyId || busy) return;
    setBusy(true);
    try {
      const res = await api.api.ledger['period-closes'].$post({
        json: { companyId, fiscalYear },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        Alert.alert('Could not close', closeErrorMessage(body?.error, fiscalYear));
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  function confirmReopen(row: ClosedRow) {
    Alert.alert(
      `Re-open ${row.fiscalYear}?`,
      `${row.fiscalYear} will accept changes again, and its profit moves back out of equity.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Re-open', onPress: () => doReopen(row.id) },
      ],
    );
  }

  async function doReopen(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.api.ledger['period-closes'][':id'].reopen.$post({ param: { id } });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        Alert.alert(
          'Could not re-open',
          body?.error === 'later_year_still_closed'
            ? 'Re-open the most recent year first.'
            : 'Could not re-open that year.',
        );
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (state === 'loading') {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-cream" edges={['top']}>
        <ActivityIndicator color="#0f1626" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Pressable onPress={() => router.back()} className="pb-2">
          <Text className="text-sm text-ink/60">← Ledger</Text>
        </Pressable>
        <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
          The Ledger
        </Text>
        <Text className="mt-2 font-serif text-3xl font-light text-ink">Close out a year</Text>
        <Text className="mt-4 text-sm leading-relaxed text-ink/60">
          Closing a year moves its profit into your business's equity and locks the year, so nothing
          can change it afterwards. Most people do this once their accountant has finished the tax
          return.
        </Text>

        {state === 'error' ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load this.</Text>
        ) : null}

        <Text className="mt-10 font-serif text-2xl font-light text-ink">Ready to close</Text>
        {closable.length === 0 ? (
          <Text className="mt-3 text-sm text-ink/70">
            Nothing to close right now. A year can be closed once it's over.
          </Text>
        ) : (
          closable.map((year) => (
            <View
              key={year.fiscalYear}
              className="mt-4 rounded-sm border border-ink/10 bg-cream-warm p-5"
            >
              <Text className="font-serif text-xl text-ink">{year.fiscalYear}</Text>
              {year.empty ? (
                <Text className="mt-1 text-sm text-ink/60">Nothing on the books this year.</Text>
              ) : (
                <Text className="mt-1 text-sm text-ink/70">
                  {Number(year.netIncome) < 0 ? 'Loss' : 'Profit'} of{' '}
                  <Text className="font-mono tabular-nums text-ink">
                    {money(String(Math.abs(Number(year.netIncome))))}
                  </Text>
                  {Number(year.withdrawals) > 0 ? (
                    <Text className="text-ink/70">
                      {' · '}
                      <Text className="font-mono tabular-nums text-ink">
                        {money(year.withdrawals)}
                      </Text>
                      {' taken out'}
                    </Text>
                  ) : null}
                </Text>
              )}
              {canAdjust && !year.empty ? (
                <Pressable
                  onPress={() => confirmClose(year)}
                  disabled={busy}
                  className="mt-4 self-start rounded-sm bg-ink px-4 py-2 active:bg-gold-deep"
                >
                  <Text className="text-sm font-medium text-cream">Close {year.fiscalYear}</Text>
                </Pressable>
              ) : null}
            </View>
          ))
        )}

        {closes.length > 0 ? (
          <>
            <Text className="mt-12 font-serif text-2xl font-light text-ink">Closed years</Text>
            {closes.map((row, i) => (
              <View key={row.id} className="mt-4 rounded-sm border border-ink/10 bg-cream-warm p-5">
                <View className="flex-row items-center justify-between">
                  <Text className="font-mono tabular-nums text-lg text-ink">{row.fiscalYear}</Text>
                  <Text className="font-mono tabular-nums text-ink/80">{money(row.netIncome)}</Text>
                </View>
                <Text className="mt-1 font-mono text-xs uppercase tracking-widest text-ink/50">
                  Closed {row.closedAt}
                </Text>
                {/* Only the most recent close can be re-opened: an earlier year
                    would stay locked by the later one anyway. */}
                {canAdjust && i === 0 ? (
                  <Pressable
                    onPress={() => confirmReopen(row)}
                    disabled={busy}
                    className="mt-3 self-start py-1"
                  >
                    <Text className="text-sm text-gold-deep">Re-open</Text>
                  </Pressable>
                ) : null}
              </View>
            ))}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

// Server error codes are accounting-shaped; the user reads plain sentences.
function closeErrorMessage(code: string | undefined, fiscalYear: number): string {
  switch (code) {
    case 'year_not_finished':
      return `${fiscalYear} isn't over yet.`;
    case 'already_closed':
      return `${fiscalYear} is already closed.`;
    case 'later_year_closed':
      return 'A more recent year is already closed. Re-open it first.';
    case 'nothing_to_close':
      return `There's nothing on the books for ${fiscalYear}.`;
    case 'equity_account_missing':
      return 'This business is missing an equity account. Contact support.';
    default:
      return 'Could not close that year.';
  }
}
