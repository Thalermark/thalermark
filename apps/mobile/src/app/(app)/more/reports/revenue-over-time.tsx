import { useState } from 'react';
import { Text, View } from 'react-native';
import { PeriodSelector } from '../../../../components/PeriodSelector';
import { ReportBody, ReportScaffold } from '../../../../components/ReportLayout';
import { api } from '../../../../lib/api';
import { fillMonths, fmt, ytdWindow } from '../../../../lib/report-periods';
import { useReport } from '../../../../lib/use-report';

// Mirror of web's /reports/revenue-over-time — a monthly sales bar chart over
// the window. The API returns only months with sales, so fillMonths makes the
// series continuous (matching web's loader).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortMonth = (key: string) => {
  const [, m] = key.split('-').map(Number);
  return MONTHS[(m ?? 1) - 1];
};

export default function RevenueOverTimeReport() {
  const [{ from, to }, setWindow] = useState(ytdWindow());
  const { data, error } = useReport(
    (companyId) =>
      api.api.companies[':id']['revenue-over-time']
        .$get({ param: { id: companyId }, query: { from, to } })
        .then((res) => (res.ok ? res.json() : null)),
    [from, to],
  );

  return (
    <ReportScaffold
      title="Revenue over time"
      selector={
        <PeriodSelector from={from} to={to} onChange={(f, t) => setWindow({ from: f, to: t })} />
      }
      note={`${from} → ${to}. Pre-tax sales from sent or paid invoices, by the month they were issued.`}
    >
      <ReportBody data={data} error={error}>
        {(d) => {
          if (Number(d.total) <= 0) {
            return <Text className="mt-8 text-ink/70">No revenue in this period.</Text>;
          }
          const series = fillMonths(d.from, d.to, d.months);
          const max = Math.max(0, ...series.map((m) => Number(m.revenue)));
          const pct = (v: string) => (max > 0 ? (Number(v) / max) * 100 : 0);
          return (
            <View className="mt-8 rounded-sm border border-ink/10 bg-cream-warm p-5">
              <View className="h-48 flex-row items-end gap-1">
                {series.map((m) => (
                  <View key={m.month} className="h-full flex-1 justify-end">
                    <View
                      className="w-full rounded-t-sm bg-gold-deep"
                      style={{ height: `${pct(m.revenue)}%` }}
                    />
                  </View>
                ))}
              </View>
              <View className="mt-2 flex-row gap-1">
                {series.map((m) => (
                  <Text
                    key={m.month}
                    className="flex-1 text-center font-mono text-[10px] uppercase tracking-wide text-ink/50"
                  >
                    {shortMonth(m.month)}
                  </Text>
                ))}
              </View>
              <View className="mt-5 flex-row items-baseline justify-between border-t border-ink/10 pt-4">
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
                  Total
                </Text>
                <Text className="font-mono text-base tabular-nums text-ink">{fmt(d.total)}</Text>
              </View>
            </View>
          );
        }}
      </ReportBody>
    </ReportScaffold>
  );
}
