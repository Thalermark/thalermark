import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
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

// Mirror of web's /reports/sales-by-customer — pre-tax sales (sent or paid),
// top 25 contacts by revenue, each with its share of the total. Rows link to
// the contact.
export default function SalesByCustomerReport() {
  const router = useRouter();
  const [{ from, to }, setWindow] = useState(ytdWindow());
  const { data, error } = useReport(
    (companyId) =>
      api.api.companies[':id']['sales-by-customer']
        .$get({ param: { id: companyId }, query: { from, to } })
        .then((res) => (res.ok ? res.json() : null)),
    [from, to],
  );

  return (
    <ReportScaffold
      title="Sales by contact"
      selector={
        <PeriodSelector from={from} to={to} onChange={(f, t) => setWindow({ from: f, to: t })} />
      }
      note={`${from} → ${to}. Pre-tax sales from sent or paid invoices, top 25 contacts by revenue.`}
    >
      <ReportBody data={data} error={error}>
        {(d) => {
          const total = Number(d.totalSales);
          if (d.contacts.length === 0) {
            return <Text className="mt-8 text-ink/70">No sales in this period.</Text>;
          }
          return (
            <ReportCard>
              {d.contacts.map((c) => (
                <Pressable
                  key={c.contactId}
                  onPress={() => router.push(`/contacts/${c.contactId}`)}
                  className="border-t border-ink/10 px-4 py-3 active:bg-cream"
                >
                  <View className="flex-row items-center justify-between">
                    <View className="flex-1 pr-3">
                      <Text className="text-ink">{c.name ?? '—'}</Text>
                      <Text className="font-mono text-xs text-ink/40">
                        {c.invoiceCount} invoice{c.invoiceCount === 1 ? '' : 's'}
                      </Text>
                    </View>
                    <Text className="font-mono text-sm tabular-nums text-ink">{fmt(c.sales)}</Text>
                  </View>
                  <ShareBar pct={total > 0 ? (Number(c.sales) / total) * 100 : 0} />
                </Pressable>
              ))}
              <TotalRow label="Total" amount={fmt(d.totalSales)} />
            </ReportCard>
          );
        }}
      </ReportBody>
    </ReportScaffold>
  );
}
