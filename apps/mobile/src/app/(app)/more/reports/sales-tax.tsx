import { useState } from 'react';
import { Text, View } from 'react-native';
import { PeriodSelector } from '../../../../components/PeriodSelector';
import { ReportBody, ReportScaffold } from '../../../../components/ReportLayout';
import { api } from '../../../../lib/api';
import { fmt, ytdWindow } from '../../../../lib/report-periods';
import { useReport } from '../../../../lib/use-report';

// Mirror of web's /reports/sales-tax — sales tax billed on invoices, net of
// voids, over the window, broken out by month. Awareness, not tax advice.
export default function SalesTaxReport() {
  const [{ from, to }, setWindow] = useState(ytdWindow());
  const { data, error } = useReport(
    (companyId) =>
      api.api.companies[':id']['sales-tax']
        .$get({ param: { id: companyId }, query: { from, to } })
        .then((res) => (res.ok ? res.json() : null)),
    [from, to],
  );

  return (
    <ReportScaffold
      title="Sales tax collected"
      selector={
        <PeriodSelector from={from} to={to} onChange={(f, t) => setWindow({ from: f, to: t })} />
      }
      note={`${from} → ${to}. Sales tax billed on your invoices, net of voids — what you've collected to remit. Awareness, not tax advice.`}
    >
      <ReportBody data={data} error={error}>
        {(d) => (
          <>
            <View className="mt-8 rounded-sm border border-ink/10 bg-cream-warm p-5">
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                Total collected
              </Text>
              <Text className="mt-2 font-serif text-4xl font-light text-ink">{fmt(d.total)}</Text>
            </View>

            {d.months.length > 0 ? (
              <View className="mt-4 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
                <View className="flex-row bg-cream px-4 py-3">
                  <Text className="flex-1 font-mono text-xs uppercase tracking-widest text-ink/50">
                    Month
                  </Text>
                  <Text className="w-32 text-right font-mono text-xs uppercase tracking-widest text-ink/50">
                    Collected
                  </Text>
                </View>
                {d.months.map((m) => (
                  <View key={m.month} className="flex-row border-t border-ink/10 px-4 py-3">
                    <Text className="flex-1 font-mono tabular-nums text-ink/80">{m.month}</Text>
                    <Text className="w-32 text-right font-mono text-sm tabular-nums text-ink">
                      {fmt(m.collected)}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
          </>
        )}
      </ReportBody>
    </ReportScaffold>
  );
}
