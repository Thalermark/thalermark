import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { PeriodSelector } from '../../../../components/PeriodSelector';
import {
  ReportBody,
  ReportCard,
  ReportScaffold,
  TotalRow,
} from '../../../../components/ReportLayout';
import { api } from '../../../../lib/api';
import { fmt, ytdWindow } from '../../../../lib/report-periods';
import { useReport } from '../../../../lib/use-report';

// Mirror of web's /reports/job-margin: which jobs actually made money.
//
// Web renders nine columns. A phone cannot, so the same rows become cards: the
// headline figure is what the job MADE, because that is the question the report
// answers, and billed / costs / per hour sit under it as supporting detail. Same
// data, same rules, different shape. This is the established mobile report
// idiom (cf. sales-by-customer), not a reduced version of the report.
//
// Named jobs and bare invoices render as one list, exactly as web flattens them:
// both are "a job" to the person reading this. A named job may own several
// invoices so it has no single date; an invoice standing in as its own job has
// no tracked hours.
type Row = {
  key: string;
  onPress: () => void;
  title: string;
  tag: string | null;
  billed: string;
  costs: string;
  // Null when the job has recognised no revenue yet: its costs are work in
  // progress and there is no margin to state (TMC-203). Rendering 0 there would
  // claim the job broke even, which is a different and false statement.
  made: string | null;
  perHour: string | null;
};

export default function JobMarginReport() {
  const router = useRouter();
  const [{ from, to }, setWindow] = useState(ytdWindow());
  const { data, error } = useReport(
    (companyId) =>
      api.api.companies[':id']['job-margin']
        .$get({ param: { id: companyId }, query: { from, to } })
        .then((res) => (res.ok ? res.json() : null)),
    [from, to],
  );

  return (
    <ReportScaffold
      title="What each job made"
      selector={
        <PeriodSelector from={from} to={to} onChange={(f, t) => setWindow({ from: f, to: t })} />
      }
      note={`${from} → ${to}. Billed is pre-tax. Costs are the ones you said were for that job, so tag a receipt with a job to see it here. Per hour is what the job paid for the time you logged against it.`}
    >
      <ReportBody data={data} error={error}>
        {(d) => {
          const rows: Row[] = [
            ...d.jobs.map((j) => ({
              key: `job:${j.jobId}`,
              onPress: () => router.push(`/jobs/${j.jobId}`),
              title: j.name,
              tag: j.customerName,
              billed: j.billed,
              costs: j.costs,
              made: j.made,
              perHour: j.minutes > 0 ? j.effectiveHourly : null,
            })),
            ...d.unjobbedInvoices.map((inv) => ({
              key: `invoice:${inv.invoiceId}`,
              onPress: () => router.push(`/invoices/${inv.invoiceId}`),
              title: inv.customerName ?? '—',
              tag: inv.number,
              billed: inv.billed,
              costs: inv.costs,
              made: inv.made,
              // An invoice standing in as its own job has no tracked hours by
              // definition, so there is no rate to state.
              perHour: null,
            })),
          ];

          if (rows.length === 0) {
            return <Text className="mt-8 text-ink-muted">No sent invoices in this period.</Text>;
          }

          return (
            <ReportCard>
              {rows.map((r) => (
                <Pressable
                  key={r.key}
                  onPress={r.onPress}
                  className="border-t border-ink/10 px-4 py-3 active:bg-cream"
                >
                  <View className="flex-row items-start justify-between">
                    <View className="flex-1 pr-3">
                      <Text className="text-ink">{r.title}</Text>
                      {r.tag ? (
                        <Text className="font-mono text-xs text-ink-subtle">{r.tag}</Text>
                      ) : null}
                    </View>
                    <Text className="font-mono text-sm tabular-nums text-ink">
                      {r.made === null ? '—' : fmt(r.made)}
                    </Text>
                  </View>
                  <Text className="mt-1 font-mono text-xs text-ink-subtle">
                    {fmt(r.billed)} billed · {fmt(r.costs)} costs
                    {r.perHour ? ` · ${fmt(r.perHour)}/hr` : ''}
                  </Text>
                </Pressable>
              ))}
              {Number(d.totals.shared) > 0 ? (
                <TotalRow label="Shared costs" amount={fmt(d.totals.shared)} />
              ) : null}
              {Number(d.totals.workInProgress) > 0 ? (
                <TotalRow label="Work in progress" amount={fmt(d.totals.workInProgress)} />
              ) : null}
              <TotalRow label="Made" amount={fmt(d.totals.made)} emphasize />
            </ReportCard>
          );
        }}
      </ReportBody>
    </ReportScaffold>
  );
}
