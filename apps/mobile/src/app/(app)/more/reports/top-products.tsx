import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { pickActiveCompany } from '../../../../lib/active-company';
import { api } from '../../../../lib/api';
import { useTrackReportView } from '../../../../lib/use-report-view';

// Mirror of apps/web's /reports/top-products. A sales lens, not a tax figure:
// pre-tax revenue grouped by source_item_id, with a single "Uncatalogued /
// other" bucket for hand-typed lines so the rows tie back to revenue. `basis`
// flips cash (paid-only) vs accrual-ish (sent or paid); the API validates it.
type Basis = 'paid' | 'sent';
type Product = {
  sourceItemId: string | null;
  name: string | null;
  revenue: string;
  lineCount: number;
};

const BASES: { key: Basis; label: string }[] = [
  { key: 'paid', label: 'Paid' },
  { key: 'sent', label: 'Sent' },
];

const fmt = (s: string) =>
  Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// Mirrors web (TMC-233): both branches describe what is counted rather than
// naming the accounting basis. The 'paid' branch used to append "(cash basis)"
// while its sibling never did, so the term leaked on one toggle position only.
const basisNote = (b: Basis) =>
  b === 'sent'
    ? 'Pre-tax revenue from invoices that have been sent or paid.'
    : 'Pre-tax revenue from paid invoices only.';

export default function TopProducts() {
  const router = useRouter();
  // report_viewed — this screen has its own layout (no ReportScaffold).
  useTrackReportView();
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [basis, setBasis] = useState<Basis>('paid');
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState(false);

  // Resolve the active company once (single-company MVP auto-picks the first).
  useFocusEffect(
    useCallback(() => {
      let active = true;
      api.api.companies
        .$get()
        .then(async (res) => {
          if (!active || !res.ok) return;
          const { companies } = await res.json();
          setCompanyId((await pickActiveCompany(companies))?.id ?? null);
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }, []),
  );

  // Refetch when the company or basis changes.
  useEffect(() => {
    if (!companyId) return;
    let active = true;
    setProducts(null);
    setError(false);
    api.api.companies[':id']['top-products']
      .$get({ param: { id: companyId }, query: { basis } })
      .then(async (res) => {
        if (!active) return;
        if (!res.ok) {
          setError(true);
          return;
        }
        const data = await res.json();
        setProducts(data.products);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [companyId, basis]);

  const total =
    products
      ?.reduce((sum, p) => sum + Number(p.revenue), 0)
      .toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
      }) ?? '';

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Pressable onPress={() => router.push('/more/reports')}>
          <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
            ← Reports
          </Text>
        </Pressable>

        <View className="mt-3 flex-row items-end justify-between gap-4">
          <Text className="font-serif text-3xl font-light text-ink">Top products</Text>
          <View className="flex-row gap-1 rounded-sm border border-ink/15 bg-cream-warm p-1">
            {BASES.map((b) => (
              <Pressable
                key={b.key}
                onPress={() => setBasis(b.key)}
                className={`rounded-sm px-3 py-1 ${basis === b.key ? 'bg-ink' : ''}`}
              >
                <Text
                  className={`font-mono text-xs uppercase tracking-widest ${
                    basis === b.key ? 'text-cream' : 'text-ink-subtle'
                  }`}
                >
                  {b.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        <Text className="mt-3 text-sm text-ink-subtle">
          {basisNote(basis)} The top 25 by revenue, plus an “Uncatalogued / other” row for
          hand-typed lines. A sales lens, not a tax figure.
        </Text>

        {error ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load the report.</Text>
        ) : products === null ? (
          <View className="mt-12 items-center">
            <ActivityIndicator className="text-ink" />
          </View>
        ) : products.length === 0 ? (
          <Text className="mt-8 text-ink-muted">No sales yet on this basis.</Text>
        ) : (
          <View className="mt-8 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
            <View className="flex-row bg-cream px-4 py-3">
              <Text className="flex-1 font-mono text-xs uppercase tracking-widest text-ink-subtle">
                Product
              </Text>
              <Text className="w-12 text-right font-mono text-xs uppercase tracking-widest text-ink-subtle">
                Lines
              </Text>
              <Text className="w-24 text-right font-mono text-xs uppercase tracking-widest text-ink-subtle">
                Revenue
              </Text>
            </View>

            {products.map((p) => (
              // Catalogued rows link to the item; the uncatalogued bucket (null
              // source) is inert. A disabled Pressable keeps the markup uniform.
              <Pressable
                key={p.sourceItemId ?? 'uncatalogued'}
                disabled={!p.sourceItemId}
                onPress={() => router.push(`/more/items/${p.sourceItemId}`)}
                className="flex-row items-center border-t border-ink/10 px-4 py-3 active:bg-cream"
              >
                {p.name ? (
                  <Text className="flex-1 text-ink">{p.name}</Text>
                ) : (
                  <Text className="flex-1 italic text-ink-subtle">Uncatalogued / other</Text>
                )}
                <Text className="w-12 text-right font-mono text-sm tabular-nums text-ink-muted">
                  {p.lineCount}
                </Text>
                <Text className="w-24 text-right font-mono text-sm tabular-nums text-ink">
                  {fmt(p.revenue)}
                </Text>
              </Pressable>
            ))}

            <View className="flex-row items-center border-t border-ink/10 bg-cream px-4 py-3">
              <Text className="flex-1 font-mono text-xs uppercase tracking-widest text-ink-muted">
                Total
              </Text>
              <Text className="w-24 text-right font-mono text-base tabular-nums text-ink">
                {total}
              </Text>
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
