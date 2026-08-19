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

// Mirror of web's /reports/tax-worksheet — the accountant handoff. Laid out like
// the IRS form rather than like our other reports: the income section, every
// deduction line in form order including the ones we never post to, then the
// totals. Someone reading figures off a phone to a preparer should be able to go
// down it line by line.
//
// One screen, four forms (TMC-162). The API dispatches on the company's business
// type and returns that form's own line table, so nothing here branches on
// entity type — the heading comes off the response.
//
// Basis is the interesting control. The ledger is always accrual; cash basis is
// a read-time lens. Omitting ?basis= lets the API apply the company's stored
// election, so the screen and Settings can't silently disagree.
type Basis = 'cash' | 'accrual';

// The words a user picked in Settings, which never says "cash" or "accrual":
// "When you get paid" / "When you send the invoice". Prose about the basis
// borrows those rather than surfacing the term raw (TMC-233). The toggle labels
// and the worksheet header keep the accountant word on purpose, because there
// the term is the thing being switched.
const basisPlain = (b: string) =>
  b === 'cash' ? 'when you get paid' : 'when you send the invoice';

const BASIS_LABELS: Record<Basis, string> = {
  cash: 'When paid',
  accrual: 'When invoiced',
};

type Row = {
  line: string;
  label: string;
  role: string;
  amount: string | null;
  accounts: { code: string; name: string; amount: string }[];
  // Non-ledger figures summed into this line's amount — standard mileage, and
  // only on Schedule C line 9 today.
  computed?: { line: string; label: string; amount: string }[];
  itemized?: true;
  userSupplied?: true;
  subLine?: true;
};

// Standard mileage (TMC-179). Present for every form: on the three corporate
// and partnership returns it isn't a deduction the business takes, but the
// driver still needs to be told what they're owed under an accountable plan.
type Mileage = {
  method: 'standard' | 'actual';
  companyMethod: string;
  miles: string;
  amount: string;
  foregone: string;
  unratedMiles: string;
  tripCount: number;
  overlapping: { code: string; name: string; amount: string }[];
};

// Schedule C Part IV. READ-ONLY on mobile, deliberately: these are annual
// answers and year-end work happens on a laptop, so the phone reports what is
// missing rather than carrying a second copy of the form.
type VehicleInfo = {
  destination: 'schedule_c_part_iv' | 'form_4562_part_v' | 'none';
  unassignedMiles: string;
  rows: {
    vehicleId: string;
    label: string;
    businessMiles: string;
    commutingMiles: string;
    otherMiles: string | null;
    totalMiles: string | null;
    placedInServiceOn: string | null;
    personalUseAvailable: boolean | null;
    anotherVehicleAvailable: boolean | null;
    missing: string[];
    inconsistent: boolean;
  }[];
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

// An em dash where nothing can fill the line — never 0.00, which would read as
// "you had none of this".
const amountOf = (r: Row) => (r.amount === null ? '—' : fmt(r.amount));

// Line number, plus the accounts behind it where more than one feeds the line,
// so an unexpected figure is traceable without leaving the screen. The catch-all
// is exempt: it gets its own itemised card below.
function subLabel(r: Row): string {
  const indent = r.subLine ? '   ' : '';
  if (r.itemized && r.accounts.length > 0) {
    return `${indent}${r.line} · itemised below`;
  }
  if (!r.itemized && r.accounts.length > 1) {
    return `${indent}${r.line} · ${r.accounts.map((a) => `${a.name} ${fmt(a.amount)}`).join(' · ')}`;
  }
  return `${indent}${r.line}`;
}

export default function TaxWorksheetReport() {
  const router = useRouter();
  const years = taxYearOptions();
  const [year, setYear] = useState(years[0] as number);
  // null = follow the company's stored election. Only a deliberate tap pins a
  // basis, which is what makes the "you're overriding Settings" notice honest.
  const [basis, setBasis] = useState<Basis | null>(null);

  const { data, error } = useReport(
    (companyId) =>
      api.api.companies[':id']['tax-worksheet']
        .$get({
          param: { id: companyId },
          query: { year, ...(basis ? { basis } : {}) },
        })
        .then(async (res) => (res.ok ? res.json() : null)),
    [year, basis],
  );

  return (
    <ReportScaffold
      title={data?.form ?? 'Tax worksheet'}
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
          const income = d.income as Row[];
          const deductions = d.deductions as Row[];
          const itemised = deductions.find((r) => r.itemized);
          const isScheduleC = d.formCode === 'schedule_c';
          const mileage = d.mileage as Mileage;
          const vehicleInfo = d.vehicleInfo as VehicleInfo;
          return (
            <>
              {overridden ? (
                <View className="mt-6 rounded-sm border border-gold-deep/30 bg-gold-deep/5 px-4 py-3">
                  <Text className="text-sm text-ink/80">
                    You're counting these{' '}
                    <Text className="font-semibold">{basisPlain(d.basis)}</Text>, but this business
                    is set to count{' '}
                    <Text className="font-semibold">
                      {basisPlain(d.companyAccountingMethod as string)}
                    </Text>
                    .
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
                    {d.form} worksheet — {d.year}
                  </Text>
                  <Text className="mt-1 text-xs text-ink/60">
                    {d.from} → {d.to} ·{' '}
                    {d.basis === 'cash'
                      ? 'Cash — counted when paid'
                      : 'Accrual — counted when invoiced'}
                  </Text>
                </View>

                <SectionHeader label={isScheduleC ? 'Part I — Income' : 'Income'} />
                {income.map((r) =>
                  r.role === 'totalIncome' ? (
                    <TotalRow key={r.line} label={`${r.line} · ${r.label}`} amount={amountOf(r)} />
                  ) : (
                    <AmountRow key={r.line} label={r.label} sub={r.line} amount={amountOf(r)} />
                  ),
                )}

                <SectionHeader label={isScheduleC ? 'Part II — Expenses' : 'Deductions'} />
                {deductions.map((r) =>
                  r.role === 'totalDeductions' || r.role === 'netIncome' ? (
                    <TotalRow
                      key={r.line}
                      label={`${r.line} · ${r.label}`}
                      amount={amountOf(r)}
                      emphasize={r.role === 'netIncome'}
                    />
                  ) : (
                    <AmountRow
                      key={r.line}
                      label={r.userSupplied ? `${r.label} — you must supply this` : r.label}
                      sub={subLabel(r)}
                      amount={amountOf(r)}
                    />
                  ),
                )}
              </ReportCard>

              {/* The itemised statement. On the 1065 / 1120-S / 1120 more than
                  half the chart lands on this one line, and the return is filed
                  with a statement breaking it down account by account — so it
                  gets its own card rather than a truncated sub-label. */}
              {itemised && itemised.accounts.length > 0 ? (
                <ReportCard>
                  <SectionHeader label={`Line ${itemised.line} — ${itemised.label}`} />
                  <View className="px-4 py-3">
                    <Text className="text-sm text-ink/70">
                      File this breakdown with the return. {d.form} has no dedicated line for these,
                      so they combine into line {itemised.line}.
                    </Text>
                  </View>
                  {itemised.accounts.map((a) => (
                    <AmountRow key={a.code} label={a.name} sub={a.code} amount={fmt(a.amount)} />
                  ))}
                  <TotalRow
                    label={`Total · line ${itemised.line}`}
                    amount={fmt(itemised.amount ?? '0.00')}
                  />
                </ReportCard>
              ) : null}

              {/* Business driving (TMC-179). Shown for every form — on the three
                  corporate/partnership returns it isn't a deduction the business
                  takes, so the copy has to say what happens instead or the
                  figure reads as one that went missing. */}
              {mileage && mileage.tripCount > 0 ? (
                <ReportCard>
                  <SectionHeader label="Business driving" />
                  <AmountRow
                    label={`${Number(mileage.miles).toLocaleString('en-US', {
                      maximumFractionDigits: 1,
                    })} miles`}
                    sub={`${mileage.tripCount} ${mileage.tripCount === 1 ? 'trip' : 'trips'}`}
                    amount={fmt(mileage.method === 'standard' ? mileage.amount : mileage.foregone)}
                  />
                  <View className="px-4 py-3">
                    {mileage.method === 'actual' ? (
                      <Text className="text-sm text-ink/70">
                        That's what a flat rate per mile would have been worth. It isn't on the
                        worksheet because this business deducts its actual vehicle costs instead.
                      </Text>
                    ) : !isScheduleC ? (
                      <Text className="text-sm text-ink/70">
                        This isn't a deduction on the business's return — the business should
                        reimburse you for it, and that payment lands on the return as an ordinary
                        vehicle expense. Ask whoever prepares your return about an accountable plan.
                      </Text>
                    ) : null}
                    {Number(mileage.unratedMiles) > 0 ? (
                      <Text className="mt-2 text-sm text-ink/70">
                        {Number(mileage.unratedMiles).toLocaleString('en-US', {
                          maximumFractionDigits: 1,
                        })}{' '}
                        of those miles are on dates the IRS hasn't set a rate for, so they aren't in
                        the figure above.
                      </Text>
                    ) : null}
                    {mileage.overlapping.length > 0 ? (
                      <Text className="mt-2 text-sm text-ink/70">
                        The rate per mile already covers fuel, repairs, insurance and the vehicle's
                        depreciation, and you've also recorded{' '}
                        {mileage.overlapping.map((a) => a.name).join(', ')} separately this year —
                        some of it may be counted twice. Parking and tolls are fine to claim on top.
                      </Text>
                    ) : null}
                  </View>
                </ReportCard>
              ) : null}

              {/* Part IV (TMC-179), read-only. The answers are annual and the
                  form is on the web; the phone's job is to say what's missing
                  so it isn't discovered in April. */}
              {vehicleInfo && vehicleInfo.destination !== 'none' && vehicleInfo.rows.length > 0 ? (
                <ReportCard>
                  <SectionHeader
                    label={
                      vehicleInfo.destination === 'schedule_c_part_iv'
                        ? 'Part IV — your vehicle'
                        : 'Your vehicle'
                    }
                  />
                  {vehicleInfo.rows.map((v) => (
                    <AmountRow
                      key={v.vehicleId}
                      label={v.label}
                      sub={
                        v.missing.length > 0
                          ? `${v.missing.length} ${v.missing.length === 1 ? 'answer' : 'answers'} missing — finish on the web`
                          : v.inconsistent
                            ? 'Total needs updating — finish on the web'
                            : `${Number(v.businessMiles).toLocaleString('en-US', { maximumFractionDigits: 1 })} business miles`
                      }
                      amount={
                        v.totalMiles === null
                          ? '—'
                          : `${Number(v.totalMiles).toLocaleString('en-US', { maximumFractionDigits: 1 })} mi`
                      }
                    />
                  ))}
                  {Number(vehicleInfo.unassignedMiles) > 0 ? (
                    <View className="px-4 py-3">
                      <Text className="text-sm text-ink/70">
                        {Number(vehicleInfo.unassignedMiles).toLocaleString('en-US', {
                          maximumFractionDigits: 1,
                        })}{' '}
                        miles are on trips that don't say which vehicle you drove, so they're in
                        your deduction but not counted against any vehicle above.
                      </Text>
                    </View>
                  ) : null}
                </ReportCard>
              ) : null}

              {/* An account we can't place still counts toward total deductions,
                  so it has to be visible — otherwise the total quietly disagrees
                  with the P&L. */}
              {d.unmappedExpenses.length > 0 ? (
                <ReportCard>
                  <SectionHeader label={`Not mapped to a ${d.form} line`} />
                  <View className="px-4 py-3">
                    <Text className="text-sm text-ink/70">
                      Included in total deductions, but we don't know which line they belong on.
                      Review these with whoever prepares your return.
                    </Text>
                  </View>
                  {d.unmappedExpenses.map((a) => (
                    <AmountRow key={a.code} label={a.name} sub={a.code} amount={fmt(a.amount)} />
                  ))}
                </ReportCard>
              ) : null}

              <Text className="mt-6 text-xs leading-relaxed text-ink/60">
                Anything marked "you must supply this" is blank because Thalermark doesn't track it
                — fill those in yourself, and note that the totals below them don't subtract what
                you add. Cost of goods sold shows zero because there's no inventory here; materials
                you bill on are recorded as supplies, and are already counted there.
                {isScheduleC
                  ? ' Schedule C part III is not included.'
                  : ' Schedules K, K-1, L, M-1 and M-2 are not included.'}
              </Text>
            </>
          );
        }}
      </ReportBody>
    </ReportScaffold>
  );
}
