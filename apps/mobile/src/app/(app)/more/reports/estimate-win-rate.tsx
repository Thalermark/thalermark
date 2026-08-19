import { useState } from 'react';
import { Text, View } from 'react-native';
import { PeriodSelector } from '../../../../components/PeriodSelector';
import { ReportBody, ReportScaffold } from '../../../../components/ReportLayout';
import { api } from '../../../../lib/api';
import { fmt, ytdWindow } from '../../../../lib/report-periods';
import { useReport } from '../../../../lib/use-report';

// Mirror of web's /reports/estimate-win-rate — how many quotes turn into work.
const ROWS: { status: string; label: string; tone: string }[] = [
  { status: 'accepted', label: 'Accepted', tone: 'text-ink' },
  { status: 'declined', label: 'Declined', tone: 'text-oxblood' },
  { status: 'expired', label: 'Expired', tone: 'text-ink-subtle' },
  { status: 'sent', label: 'Sent (awaiting)', tone: 'text-ink-subtle' },
  { status: 'draft', label: 'Draft', tone: 'text-ink-subtle' },
];

export default function EstimateWinRateReport() {
  const [{ from, to }, setWindow] = useState(ytdWindow());
  const { data, error } = useReport(
    (companyId) =>
      api.api.companies[':id']['estimate-win-rate']
        .$get({ param: { id: companyId }, query: { from, to } })
        .then((res) => (res.ok ? res.json() : null)),
    [from, to],
  );

  return (
    <ReportScaffold
      title="Estimate win rate"
      selector={
        <PeriodSelector from={from} to={to} onChange={(f, t) => setWindow({ from: f, to: t })} />
      }
      note={`${from} → ${to}. Of the estimates you've heard back on (accepted, declined, or expired), how many turned into work.`}
    >
      <ReportBody data={data} error={error}>
        {(d) => {
          const winPct = d.winRate === null ? null : Math.round(Number(d.winRate) * 100);
          const byStatus = new Map(d.byStatus.map((s) => [s.status as string, s]));
          return (
            <>
              <View className="mt-8 rounded-sm border border-ink/10 bg-cream-warm p-5">
                <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                  Win rate
                </Text>
                <Text className="mt-2 font-serif text-4xl font-light text-ink">
                  {winPct === null ? '—' : `${winPct}%`}
                </Text>
                <Text className="mt-1 text-xs text-ink-subtle">
                  {winPct === null
                    ? 'Nothing decided yet'
                    : `${d.acceptedCount} of ${d.decidedCount} decided`}
                </Text>
              </View>

              <View className="mt-4 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
                <View className="flex-row bg-cream px-4 py-3">
                  <Text className="flex-1 font-mono text-xs uppercase tracking-widest text-ink-subtle">
                    Status
                  </Text>
                  <Text className="w-16 text-right font-mono text-xs uppercase tracking-widest text-ink-subtle">
                    Count
                  </Text>
                  <Text className="w-28 text-right font-mono text-xs uppercase tracking-widest text-ink-subtle">
                    Value
                  </Text>
                </View>
                {ROWS.map((r) => {
                  const row = byStatus.get(r.status);
                  return (
                    <View
                      key={r.status}
                      className="flex-row items-center border-t border-ink/10 px-4 py-3"
                    >
                      <Text className={`flex-1 ${r.tone}`}>{r.label}</Text>
                      <Text className="w-16 text-right font-mono text-sm tabular-nums text-ink-muted">
                        {row?.count ?? 0}
                      </Text>
                      <Text className="w-28 text-right font-mono text-sm tabular-nums text-ink">
                        {fmt(row?.value ?? '0.00')}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </>
          );
        }}
      </ReportBody>
    </ReportScaffold>
  );
}
