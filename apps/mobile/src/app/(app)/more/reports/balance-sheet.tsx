import { useState } from 'react';
import { Text, View } from 'react-native';
import { AsOfSelector } from '../../../../components/AsOfSelector';
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
import { fmt, todayYmd } from '../../../../lib/report-periods';
import { useReport } from '../../../../lib/use-report';

// Mirror of web's /reports/balance-sheet — point-in-time A = L + E, with any
// profit not yet closed out carried in equity.
export default function BalanceSheetReport() {
  const [asOf, setAsOf] = useState(todayYmd());
  const { data, error } = useReport(
    (companyId) =>
      api.api.companies[':id']['balance-sheet']
        .$get({ param: { id: companyId }, query: { asOf } })
        .then((res) => (res.ok ? res.json() : null)),
    [asOf],
  );

  return (
    <ReportScaffold
      title="Balance sheet"
      selector={<AsOfSelector asOf={asOf} onChange={setAsOf} />}
      note={`As of ${asOf}. What the business owns and owes. Assets equal liabilities plus equity — profit you haven't closed out yet is carried in equity.`}
    >
      <ReportBody data={data} error={error}>
        {(d) => (
          <>
            <ReportCard>
              <SectionHeader label="Assets" />
              {d.assets.length === 0 ? (
                <EmptyRow text="No assets." />
              ) : (
                d.assets.map((a) => (
                  <AmountRow key={a.code} label={a.name} amount={fmt(a.amount)} />
                ))
              )}
              <TotalRow label="Total assets" amount={fmt(d.totalAssets)} emphasize />
            </ReportCard>

            <ReportCard>
              <SectionHeader label="Liabilities" />
              {d.liabilities.length === 0 ? (
                <EmptyRow text="No liabilities." />
              ) : (
                d.liabilities.map((l) => (
                  <AmountRow key={l.code} label={l.name} amount={fmt(l.amount)} />
                ))
              )}
              <TotalRow label="Total liabilities" amount={fmt(d.totalLiabilities)} />

              <SectionHeader label="Equity" />
              {d.equity.map((e) => (
                <AmountRow key={e.code} label={e.name} amount={fmt(e.amount)} />
              ))}
              {/* Profit the books still carry loose — everything earned since the
                  last year-end close. Deliberately NOT "retained earnings": a
                  corporation has a real 3400 Retained Earnings row listed above,
                  and two rows by the same name is the first thing their
                  accountant would query. */}
              <AmountRow label="Net income (not yet closed)" amount={fmt(d.netIncome)} />
              <TotalRow label="Total equity" amount={fmt(d.totalEquity)} />

              <View className="border-t-2 border-ink/15">
                <TotalRow
                  label="Liabilities + equity"
                  amount={fmt(d.totalLiabilitiesAndEquity)}
                  emphasize
                />
              </View>
            </ReportCard>

            {/* Mirrors web's wording exactly (TMC-233). `balanced` is true by
                construction, so a false is never something the reader caused or
                can fix; the copy says so and reassures that nothing was lost. */}
            {!d.balanced ? (
              <View className="mt-4 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
                <Text className="text-sm text-oxblood">
                  These two totals should match and they don't. Nothing you entered has been lost,
                  and there's nothing to fix on your end. Please contact support.
                </Text>
              </View>
            ) : null}
          </>
        )}
      </ReportBody>
    </ReportScaffold>
  );
}
