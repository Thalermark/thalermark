import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { AsOfSelector } from '../../../../components/AsOfSelector';
import { ReportBody, ReportScaffold, TotalRow } from '../../../../components/ReportLayout';
import { api } from '../../../../lib/api';
import { fmt, todayYmd } from '../../../../lib/report-periods';
import { useReport } from '../../../../lib/use-report';

// Mirror of web's /reports/ar-aging — unpaid sent invoices bucketed by how
// overdue they are. Overdue rows get progressively redder.
const tone = (days: number) =>
  days <= 0
    ? 'text-ink/70'
    : days <= 30
      ? 'text-ink'
      : days <= 90
        ? 'text-gold-deep'
        : 'text-oxblood';

export default function ArAgingReport() {
  const router = useRouter();
  const [asOf, setAsOf] = useState(todayYmd());
  const { data, error } = useReport(
    (companyId) =>
      api.api.companies[':id']['ar-aging']
        .$get({ param: { id: companyId }, query: { asOf } })
        .then((res) => (res.ok ? res.json() : null)),
    [asOf],
  );

  return (
    <ReportScaffold
      title="A/R aging"
      selector={<AsOfSelector asOf={asOf} onChange={setAsOf} />}
      note={`As of ${asOf}. Sent invoices that haven't been paid, by how overdue they are.`}
    >
      <ReportBody data={data} error={error}>
        {(d) => (
          <>
            <View className="mt-8 flex-row flex-wrap gap-3">
              {d.buckets.map((b) => (
                <View
                  key={b.key}
                  className="grow basis-[45%] rounded-sm border border-ink/10 bg-cream-warm p-4"
                >
                  <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                    {b.label}
                  </Text>
                  <Text className="mt-2 font-mono text-lg tabular-nums text-ink">
                    {fmt(b.amount)}
                  </Text>
                  <Text className="mt-0.5 text-xs text-ink/50">
                    {b.count} invoice{b.count === 1 ? '' : 's'}
                  </Text>
                </View>
              ))}
            </View>

            {d.invoices.length === 0 ? (
              <Text className="mt-8 text-ink/70">Nothing outstanding — you're all paid up.</Text>
            ) : (
              <View className="mt-6 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
                {d.invoices.map((inv) => (
                  <Pressable
                    key={inv.id}
                    onPress={() => router.push(`/invoices/${inv.id}`)}
                    className="border-t border-ink/10 px-4 py-3 active:bg-cream"
                  >
                    <View className="flex-row items-center justify-between">
                      <Text className="font-serif text-ink">{inv.number}</Text>
                      <Text className="font-mono text-sm tabular-nums text-ink">
                        {fmt(inv.amount)}
                      </Text>
                    </View>
                    <View className="mt-1 flex-row items-center justify-between">
                      <View className="flex-1 pr-3">
                        <Text className="text-sm text-ink/70">{inv.customerName ?? '—'}</Text>
                        <Text className="font-mono text-xs text-ink/40">due {inv.dueDate}</Text>
                      </View>
                      <Text className={`font-mono text-xs tabular-nums ${tone(inv.daysPastDue)}`}>
                        {inv.daysPastDue <= 0 ? 'Current' : `${inv.daysPastDue}d`}
                      </Text>
                    </View>
                  </Pressable>
                ))}
                <TotalRow label="Total outstanding" amount={fmt(d.total)} />
              </View>
            )}
          </>
        )}
      </ReportBody>
    </ReportScaffold>
  );
}
