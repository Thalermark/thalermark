import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  AmountRow,
  ReportBody,
  ReportCard,
  ReportScaffold,
  SectionHeader,
  TotalRow,
} from '../../../../components/ReportLayout';
import { api } from '../../../../lib/api';
import { fmt, taxYearOptions } from '../../../../lib/report-periods';
import { useReport } from '../../../../lib/use-report';

// Mirror of web's /reports/schedule-c — the accountant handoff. Laid out like
// the IRS form rather than like our other reports: Part I lines 1-7, every Part
// II line in form order including the ones we never post to, then 28/29/30/31.
// Someone reading figures off a phone to a preparer should be able to go down it
// line by line.
//
// Basis is the interesting control. The ledger is always accrual; cash basis is
// a read-time lens. Omitting ?basis= lets the API apply the company's stored
// election, so the screen and Settings can't silently disagree.
type Basis = 'cash' | 'accrual';

const BASIS_LABELS: Record<Basis, string> = {
  cash: 'When paid',
  accrual: 'When invoiced',
};

// Chip row matching PeriodSelector's styling — the report screens' shared idiom
// for a small set of mutually exclusive choices.
function ChipRow<T extends string | number>({
  label,
  options,
  value,
  render,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T;
  render: (v: T) => string;
  onChange: (v: T) => void;
}) {
  return (
    <View className="mt-3">
      <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">{label}</Text>
      <View className="mt-2 flex-row flex-wrap gap-1 rounded-sm border border-ink/15 bg-cream-warm p-1">
        {options.map((o) => (
          <Pressable
            key={String(o)}
            onPress={() => onChange(o)}
            className={`rounded-sm px-3 py-1 ${o === value ? 'bg-ink' : ''}`}
          >
            <Text
              className={`font-mono text-xs uppercase tracking-widest ${
                o === value ? 'text-cream' : 'text-ink/60'
              }`}
            >
              {render(o)}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export default function ScheduleCReport() {
  const router = useRouter();
  const years = taxYearOptions();
  const [year, setYear] = useState(years[0] as number);
  // null = follow the company's stored election. Only a deliberate tap pins a
  // basis, which is what makes the "you're overriding Settings" notice honest.
  const [basis, setBasis] = useState<Basis | null>(null);
  // The API 409s when the business doesn't file a Schedule C (partnership /
  // S-corp / C-corp — TMC-124). The hub hides the card for them, so this only
  // happens on a back-navigation or a deep link after the type changed. Naming
  // their actual form beats the generic "couldn't load this report".
  const [wrongForm, setWrongForm] = useState<string | null>(null);

  const { data, error } = useReport(
    (companyId) =>
      api.api.companies[':id']['schedule-c']
        .$get({
          param: { id: companyId },
          query: { year, ...(basis ? { basis } : {}) },
        })
        .then(async (res) => {
          if (res.status === 409) {
            const body = (await res.json().catch(() => null)) as { taxForm?: string } | null;
            setWrongForm(body?.taxForm ?? 'a different return');
            return null;
          }
          setWrongForm(null);
          return res.ok ? res.json() : null;
        }),
    [year, basis],
  );

  if (wrongForm) {
    return (
      <ReportScaffold
        title="Schedule C"
        selector={null}
        note={`Schedule C isn't your form — your business files ${wrongForm}. A worksheet for it is on the way; meanwhile your profit & loss and general ledger have the figures your accountant needs.`}
      >
        {null}
      </ReportScaffold>
    );
  }

  return (
    <ReportScaffold
      title="Schedule C"
      selector={
        <View>
          <ChipRow
            label="Tax year"
            options={years}
            value={year}
            render={(y) => String(y)}
            onChange={setYear}
          />
          <ChipRow
            label="Counting"
            options={['cash', 'accrual'] as const}
            value={(basis ?? data?.basis ?? 'cash') as Basis}
            render={(b) => BASIS_LABELS[b]}
            onChange={setBasis}
          />
        </View>
      }
      note="A worksheet to hand to whoever prepares your return — not a filing, and not tax advice."
    >
      <ReportBody data={data} error={error}>
        {(d) => {
          const overridden = d.basis !== d.companyAccountingMethod;
          return (
            <>
              {overridden ? (
                <View className="mt-6 rounded-sm border border-gold-deep/30 bg-gold-deep/5 px-4 py-3">
                  <Text className="text-sm text-ink/80">
                    Showing <Text className="font-semibold">{d.basis}</Text> figures, but this
                    business is set to{' '}
                    <Text className="font-semibold">{d.companyAccountingMethod}</Text>.
                  </Text>
                  <Pressable onPress={() => router.push('/more/business')}>
                    <Text className="mt-1 text-sm text-gold-deep">
                      Change the saved setting in Business settings →
                    </Text>
                  </Pressable>
                </View>
              ) : null}

              <ReportCard>
                <View className="px-4 py-3">
                  <Text className="font-serif text-lg text-ink">
                    Schedule C worksheet — {d.year}
                  </Text>
                  <Text className="mt-1 text-xs text-ink/60">
                    {d.from} → {d.to} ·{' '}
                    {d.basis === 'cash'
                      ? 'Cash — counted when paid'
                      : 'Accrual — counted when invoiced'}
                  </Text>
                </View>

                <SectionHeader label="Part I — Income" />
                <AmountRow
                  label="Gross receipts or sales"
                  sub="1"
                  amount={fmt(d.partI.grossReceipts)}
                />
                <AmountRow
                  label="Returns and allowances"
                  sub="2"
                  amount={fmt(d.partI.returnsAndAllowances)}
                />
                <AmountRow
                  label="Cost of goods sold"
                  sub="4"
                  amount={fmt(d.partI.costOfGoodsSold)}
                />
                <AmountRow label="Other income" sub="6" amount={fmt(d.partI.otherIncome)} />
                <TotalRow label="7 · Gross income" amount={fmt(d.partI.grossIncome)} />

                <SectionHeader label="Part II — Expenses" />
                {d.partII.map((row) => (
                  <AmountRow
                    key={row.line}
                    label={row.userSupplied ? `${row.label} — you must supply this` : row.label}
                    // Line number as the sub-label plus, where more than one
                    // account feeds a line, the accounts behind it — so an
                    // unexpected figure is traceable without leaving the screen.
                    sub={
                      row.accounts.length > 1
                        ? `${row.line} · ${row.accounts.map((a) => `${a.name} ${fmt(a.amount)}`).join(' · ')}`
                        : row.line
                    }
                    amount={fmt(row.amount)}
                  />
                ))}

                <TotalRow label="28 · Total expenses" amount={fmt(d.totalExpenses)} />
                <AmountRow
                  label="Tentative profit or loss"
                  sub="29"
                  amount={fmt(d.tentativeProfit)}
                />
                <AmountRow
                  label="Business use of your home — you must supply this"
                  sub="30"
                  amount="—"
                />
                <TotalRow label="31 · Net profit or loss" amount={fmt(d.netProfit)} emphasize />
              </ReportCard>

              {/* An account we can't place still counts toward line 28, so it has
                  to be visible — otherwise line 28 quietly disagrees with the
                  P&L. */}
              {d.unmappedExpenses.length > 0 ? (
                <ReportCard>
                  <SectionHeader label="Not mapped to a Schedule C line" />
                  <View className="px-4 py-3">
                    <Text className="text-sm text-ink/70">
                      Included in line 28, but we don't know which line they belong on. Review these
                      with whoever prepares your return.
                    </Text>
                  </View>
                  {d.unmappedExpenses.map((a) => (
                    <AmountRow key={a.code} label={a.name} sub={a.code} amount={fmt(a.amount)} />
                  ))}
                </ReportCard>
              ) : null}

              <Text className="mt-6 text-xs leading-relaxed text-ink/60">
                Line 9 (car and truck) and line 30 (business use of your home) are blank because
                Thalermark doesn't track mileage or home-office use — fill those in yourself. Line
                31 does not subtract line 30. Part III (cost of goods sold) is not included;
                materials you bill on are recorded under supplies, line 22.
              </Text>
            </>
          );
        }}
      </ReportBody>
    </ReportScaffold>
  );
}
