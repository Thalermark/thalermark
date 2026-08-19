import { useState } from 'react';
import { Text, View } from 'react-native';
import { PeriodSelector } from '../../../../components/PeriodSelector';
import {
  ReportBody,
  ReportCard,
  ReportScaffold,
  ShareBar,
  TotalRow,
} from '../../../../components/ReportLayout';
import { api } from '../../../../lib/api';
import { fmt, ytdWindow } from '../../../../lib/report-periods';
import { useReport } from '../../../../lib/use-report';

// Mirror of web's /reports/expenses-by-category — the expense section of the
// P&L (same endpoint), biggest-first, with each category's share of the total.
export default function ExpensesByCategoryReport() {
  const [{ from, to }, setWindow] = useState(ytdWindow());
  const { data, error } = useReport(
    (companyId) =>
      api.api.companies[':id']['profit-loss']
        .$get({ param: { id: companyId }, query: { from, to } })
        .then((res) => (res.ok ? res.json() : null)),
    [from, to],
  );

  // The note names no tax form: the categories map to whichever return the
  // business files (Schedule C / 1065 / 1120-S / 1120), and each row prints its
  // own tax line anyway.
  return (
    <ReportScaffold
      title="Expenses by category"
      selector={
        <PeriodSelector from={from} to={to} onChange={(f, t) => setWindow({ from: f, to: t })} />
      }
      note={`${from} → ${to}. Where your money went, biggest first.`}
    >
      <ReportBody data={data} error={error}>
        {(d) => {
          const total = Number(d.totalExpenses);
          const rows = [...d.expenses].sort((a, b) => Number(b.amount) - Number(a.amount));
          if (rows.length === 0) {
            return (
              <Text className="mt-8 text-ink-muted">No expenses recorded in this period.</Text>
            );
          }
          return (
            <ReportCard>
              {rows.map((e) => (
                <View key={e.code} className="border-t border-ink/10 px-4 py-3">
                  <View className="flex-row items-center justify-between">
                    <View className="flex-1 pr-3">
                      <Text className="text-ink/80">{e.name}</Text>
                      {e.taxMapping ? (
                        <Text className="font-mono text-xs text-ink-subtle">{e.taxMapping}</Text>
                      ) : null}
                    </View>
                    <Text className="font-mono text-sm tabular-nums text-ink">{fmt(e.amount)}</Text>
                  </View>
                  <ShareBar pct={total > 0 ? (Number(e.amount) / total) * 100 : 0} />
                </View>
              ))}
              <TotalRow label="Total" amount={fmt(d.totalExpenses)} />
            </ReportCard>
          );
        }}
      </ReportBody>
    </ReportScaffold>
  );
}
