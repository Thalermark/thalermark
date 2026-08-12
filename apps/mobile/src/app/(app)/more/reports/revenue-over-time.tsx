import { useState } from 'react';
import { Text, View } from 'react-native';
import { PeriodSelector } from '../../../../components/PeriodSelector';
import { ReportBody, ReportScaffold } from '../../../../components/ReportLayout';
import { ColumnChart } from '../../../../components/charts';
import { api } from '../../../../lib/api';
import { fillMonths, fmt, ytdWindow } from '../../../../lib/report-periods';
import { useReport } from '../../../../lib/use-report';

// Mirror of web's /reports/revenue-over-time — a monthly sales bar chart over
// the window. The API returns only months with sales, so fillMonths makes the
// series continuous (matching web's loader).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Carries the year when — and only when — the window spans more than one.
// Matching the web tick exactly: both used to print a bare 'Jan', so a range
// crossing a year end read "Jan … Dec Jan … Dec" with nothing to separate them.
const monthTick = (key: string, spansYears: boolean) => {
  const [y, m] = key.split('-').map(Number);
  const name = MONTHS[(m ?? 1) - 1];
  return spansYears ? `${name} ${String(y).slice(2)}` : (name ?? key);
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
          const spansYears = new Set(series.map((m) => m.month.slice(0, 4))).size > 1;
          return (
            <View className="mt-8 rounded-sm border border-ink/10 bg-cream-warm p-5">
              <ColumnChart
                data={series}
                x={{
                  key: 'month',
                  label: (m) => monthTick(m.month, spansYears),
                  title: 'Month',
                }}
                series={[{ key: 'revenue', label: 'Revenue' }]}
                caption={`Revenue by month, ${d.from} to ${d.to}.`}
                empty="No revenue in this period."
              />
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
