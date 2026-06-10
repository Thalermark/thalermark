import { useState } from 'react';
import { View } from 'react-native';
import { PeriodSelector } from '../../../../components/PeriodSelector';
import {
  AmountRow,
  EmptyRow,
  ReportBody,
  ReportCard,
  ReportScaffold,
  SectionHeader,
  TotalRow,
} from '../../../../components/ReportLayout';
import { api } from '../../../../lib/api';
import { fmt, ytdWindow } from '../../../../lib/report-periods';
import { useReport } from '../../../../lib/use-report';

// Mirror of web's /reports/profit-and-loss. Accrual income statement off the GL.
export default function ProfitAndLossReport() {
  const [{ from, to }, setWindow] = useState(ytdWindow());
  const { data, error } = useReport(
    (companyId) =>
      api.api.companies[':id']['profit-loss']
        .$get({ param: { id: companyId }, query: { from, to } })
        .then((res) => (res.ok ? res.json() : null)),
    [from, to],
  );

  return (
    <ReportScaffold
      title="Profit & loss"
      selector={
        <PeriodSelector from={from} to={to} onChange={(f, t) => setWindow({ from: f, to: t })} />
      }
      note={`${from} → ${to}. Accrual basis: revenue when an invoice is sent or paid, expenses when recorded. May differ from cash actually received.`}
    >
      <ReportBody data={data} error={error}>
        {(d) => (
          <ReportCard>
            <SectionHeader label="Revenue" />
            {d.revenue.length === 0 ? (
              <EmptyRow text="No revenue in this period." />
            ) : (
              d.revenue.map((r) => <AmountRow key={r.code} label={r.name} amount={fmt(r.amount)} />)
            )}
            <TotalRow label="Total revenue" amount={fmt(d.totalRevenue)} />

            <SectionHeader label="Expenses" />
            {d.expenses.length === 0 ? (
              <EmptyRow text="No expenses in this period." />
            ) : (
              d.expenses.map((e) => (
                <AmountRow key={e.code} label={e.name} amount={fmt(e.amount)} />
              ))
            )}
            <TotalRow label="Total expenses" amount={fmt(d.totalExpenses)} />

            <View className="border-t-2 border-ink/15">
              <TotalRow
                label="Net profit"
                amount={fmt(d.netProfit)}
                emphasize
                tone={Number(d.netProfit) >= 0 ? 'ink' : 'oxblood'}
              />
            </View>
          </ReportCard>
        )}
      </ReportBody>
    </ReportScaffold>
  );
}
