import { createHash } from 'node:crypto';
import {
  CASH_FLOW_NUDGE_VERSION,
  type CashFlowAdvisor,
  type CashFlowSignals,
  createCashFlowAdvisor,
} from '@thalermark/ai';
import {
  type Transaction,
  bills,
  chartOfAccounts,
  companies,
  contacts,
  estimates,
  expenseAllocations,
  expenses,
  invoiceLineItems,
  invoices,
  items,
  // Aliased: the job-margin handler has a local `jobs` in its response shape.
  jobs as jobsTable,
  journalEntries,
  journalLines,
  mileageTrips,
  vehicleYears,
  vehicles,
} from '@thalermark/db';
import {
  type PartIVGap,
  centsToMoney,
  partIVForVehicle,
  sumMoney,
  summariseMileage,
  toCents,
} from '@thalermark/validation';
import type { AnyColumn, SQL } from 'drizzle-orm';
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  sql,
} from 'drizzle-orm';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import type { AppDeps } from '../app.js';
import {
  displayHours,
  effectiveHourly,
  jobBilledCents,
  jobDraftedCents,
  jobMade,
  jobMinutes,
  jobUnbilled,
} from '../lib/job-costing.js';
import { apBalance, arBalance, cashFlowNet, cashOnHand } from '../lib/ledger.js';
import { recordLlmCallHealth } from '../lib/llm-connection.js';
import { resolveAccountCredential } from '../lib/llm-credentials.js';
import { UUID_RE, localToday } from '../lib/route-helpers.js';
import {
  type ExpenseAccountAmount,
  type TaxLineRow,
  type VehicleInfoDestination,
  rollUpDeductions,
  standardMileageAddend,
  taxFormFor,
  taxYearWindow,
  vehicleInfoDestination,
} from '../lib/tax-worksheet.js';
import { requireEntitlement } from '../middleware/entitlement.js';
import { RATE_LIMITS, rateLimit } from '../middleware/rate-limit.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// reports — the dashboard / reports / AI-insight domain: the company-scoped
// read surface that turns the hidden ledger into the product's answers.
// Position dashboard, top products, P&L, sales-by-customer, revenue-over-time,
// estimate win rate, balance sheet, A/R aging, sales tax, plus the two AI
// insights (cash-flow nudges, spending anomalies). All GET reads off the
// ledger; the only deps user is the cash-flow advisor (deps.advisor) which
// narrates deterministic ledger signals — the nudge cache is DB-backed
// (companies.cash_flow_nudges + a CASH_FLOW_NUDGE_VERSION-tagged input hash),
// no module state. Mounted on createApp via .route() so its schema rides on its
// own ReportsAppType instead of bloating AppType past TS7056. These all live
// under /api/companies/:id/* — the company CRUD/settings half is the companies
// sub-app; extracting them here empties the /api/companies/:id prefix from
// AppType, so the facade's split-prefix intersection collapses to a plain
// override (see api.server.ts / mobile api.ts).

// The instant a calendar day *begins* in the company's timezone (TMC-157).
//
// Resolved in Postgres rather than JS on purpose. `AT TIME ZONE` reads the same
// tz database the server ships, so DST transitions, historical offset changes
// and zone renames are all handled — hand-rolled JS offset math gets the
// ordinary cases right and the interesting ones wrong. Both operands are bound
// parameters, so a stored zone string never becomes SQL.
//
// Before this, every window was UTC: a payment taken at 8pm on 31 December in
// America/Chicago stored as 2027-01-01T02:00Z and fell into the *next* tax
// year. Companies default to 'UTC', which reproduces exactly the old behaviour
// until someone sets a real zone.
function dayStartInstant(day: string, tz: string) {
  return sql<Date>`(${day}::timestamp AT TIME ZONE ${tz})`;
}

// Bucket a timestamptz by month in the company's local time. Only for
// timestamptz columns — a bare `date` column (issue_date) is already a calendar
// date with no zone, and shifting it would be wrong.
function localMonthExpr(column: AnyColumn, tz: string) {
  return sql<string>`to_char(date_trunc('month', ${column} AT TIME ZONE ${tz}), 'YYYY-MM')`;
}

// Add days to a YYYY-MM-DD calendar date, staying in calendar space — no
// instants involved, so DST can't skew it. Used to turn an inclusive `to` into
// the half-open upper bound.
function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// Parse a from/to reporting window shared by the report endpoints. Both are
// optional; the default is year-to-date through today. Returns the inclusive
// display strings plus the half-open [fromInstant, toExclusiveInstant) bounds
// (to + 1 day, so the last day is fully included — the same convention as the
// ledger export / dashboard); or an `error` code the caller turns into a 400.
//
// `from`/`to` remain plain calendar dates and stay suitable for direct
// comparison against bare `date` columns (issue_date), which carry no zone and
// must NOT be shifted.
type ReportWindow = {
  fromInstant: SQL<Date>;
  toExclusiveInstant: SQL<Date>;
  from: string;
  to: string;
};
function parseReportWindow(
  fromRaw: string | undefined,
  toRaw: string | undefined,
  tz: string,
): ReportWindow | { error: 'invalid_from' | 'invalid_to' | 'invalid_range' } {
  const today = localToday(tz);
  let from: string;
  if (fromRaw !== undefined) {
    if (Number.isNaN(Date.parse(`${fromRaw}T00:00:00Z`))) return { error: 'invalid_from' };
    from = fromRaw;
  } else {
    from = `${today.slice(0, 4)}-01-01`;
  }
  let to: string;
  if (toRaw !== undefined) {
    if (Number.isNaN(Date.parse(`${toRaw}T00:00:00Z`))) return { error: 'invalid_to' };
    to = toRaw;
  } else {
    to = today;
  }
  if (from > to) return { error: 'invalid_range' };
  return {
    from,
    to,
    fromInstant: dayStartInstant(from, tz),
    toExclusiveInstant: dayStartInstant(addDays(to, 1), tz),
  };
}

// Year-end closing entries must not appear in a P&L-shaped report (TMC-159).
//
// A close zeroes the revenue and expense accounts by posting the opposite of
// each balance, dated inside the year it closes. That is right for the balance
// sheet — it's what moves the profit into equity — but any report that sums P&L
// activity over a window would see those flip lines and report the closed year
// as zero. So every revenue/expense aggregation below excludes both the close
// and its reversal.
//
// The GL export and trial balance deliberately do NOT filter them: those are the
// raw ledger, and the closing entry is a real entry an accountant expects to see.
const CLOSING_ENTRY_SOURCES = ['year_end_close', 'year_end_close_reversal'];
const notAClosingEntry = () => notInArray(journalEntries.sourceEntityType, CLOSING_ENTRY_SOURCES);

// localToday moved to lib/route-helpers.ts when the invoice mark-paid path
// needed the same operator's-midnight rule to date a receipt (TMC-196).

// Parse a single as-of date (YYYY-MM-DD) for point-in-time reports (balance
// sheet, A/R aging). Default is today in the company's zone. Returns the
// inclusive display string + the half-open upper bound (asOf + 1 day) so a
// balance includes everything posted any time on the as-of day; or an `error`
// for a 400.
function parseAsOf(
  raw: string | undefined,
  tz: string,
): { asOf: string; asOfExclusiveInstant: SQL<Date> } | { error: 'invalid_as_of' } {
  let asOf: string;
  if (raw !== undefined) {
    if (Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) return { error: 'invalid_as_of' };
    asOf = raw;
  } else {
    asOf = localToday(tz);
  }
  return { asOf, asOfExclusiveInstant: dayStartInstant(addDays(asOf, 1), tz) };
}

// --- Tax worksheet --------------------------------------------------------
// Shared by GET /tax-worksheet and its legacy /schedule-c alias. The SQL runs
// once; the two routes are two projections of the same result.

// Query shape for both routes. Extracted so the alias can't drift from the
// endpoint it aliases.
// The success branch's properties are declared OPTIONAL, not merely
// `T | undefined`. Hono derives the typed client's `query` input from this
// return type, so a required-but-undefinable property would force every caller
// to pass every filter explicitly — and adding one would break them all.
function taxWorksheetQuery(
  v: Record<string, string | string[] | undefined>,
):
  | { error: 'invalid_basis' | 'invalid_method' | 'invalid_year' }
  | { basis?: 'cash' | 'accrual'; year?: number; method?: 'standard' | 'actual' } {
  const basis = v.basis;
  if (basis !== undefined && basis !== 'cash' && basis !== 'accrual') {
    return { error: 'invalid_basis' as const };
  }
  // The vehicle election, overridable per request exactly like basis — so the
  // two figures can be compared without flipping the saved election in Settings
  // (TMC-179).
  const method = v.method;
  if (method !== undefined && method !== 'standard' && method !== 'actual') {
    return { error: 'invalid_method' as const };
  }
  const yearRaw = v.year;
  let year: number | undefined;
  if (typeof yearRaw === 'string') {
    year = Number(yearRaw);
    // A tax year outside this range is a typo, not a filing. Bounding it also
    // keeps taxYearWindow from building nonsense Dates.
    if (!Number.isInteger(year) || year < 1900 || year > 2200) {
      return { error: 'invalid_year' as const };
    }
  }
  return {
    ...(basis ? { basis } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(method ? { method } : {}),
  };
}

type TaxWorksheet = {
  form: string;
  formCode: string;
  year: number;
  basis: 'cash' | 'accrual';
  companyAccountingMethod: string;
  from: string;
  to: string;
  income: TaxLineRow[];
  deductions: TaxLineRow[];
  unmappedExpenses: { code: string; name: string; amount: string }[];
  totalDeductions: string;
  netIncome: string;
  // Standard mileage (TMC-179). Present for EVERY form, not just Schedule C —
  // only the *addend onto a line* is Schedule-C-only. An S-corp owner who logged
  // 8,000 miles still needs to be told what the business owes them under an
  // accountable plan, and the worksheet is where the year's figures live.
  mileage: {
    method: 'standard' | 'actual';
    // Mirrors companyAccountingMethod: lets the UI say "showing standard, your
    // saved election is actual" rather than silently disagreeing with Settings.
    companyMethod: string;
    miles: string;
    // What the rated miles are worth. Zero under the 'actual' election, where
    // `foregone` carries the figure instead.
    amount: string;
    // What standard mileage WOULD have been worth. Always populated, so an
    // 'actual' filer can see what they are giving up without flipping the
    // saved election.
    foregone: string;
    unratedMiles: string;
    tripCount: number;
    // Accounts standard mileage already covers that carry a balance this year.
    // NOT netted out — we cannot know which part of Repairs was the truck — but
    // NAMED, because claiming both is a double deduction. Empty under 'actual'.
    overlapping: { code: string; name: string; amount: string }[];
  };
  // Schedule C Part IV, "Information on Your Vehicle" (TMC-179). A sibling of
  // `mileage`, deliberately NOT rows in `deductions`: a TaxLineRow is
  // money-shaped and feeds totalDeductions, and these are a date and two
  // yes/nos. Present on every form — `destination` says whether it goes
  // anywhere.
  vehicleInfo: {
    destination: VehicleInfoDestination;
    // Miles this year on trips naming no vehicle. THE one new way to file a
    // wrong return: those miles fed line 9, but belong to no Part IV row, so
    // the sum of the rows below would understate what was claimed. Surfaced and
    // explained, never silently absorbed — the same treatment unratedMiles got.
    unassignedMiles: string;
    rows: {
      vehicleId: string;
      label: string;
      placedInServiceOn: string | null;
      businessMiles: string;
      commutingMiles: string;
      otherMiles: string | null;
      totalMiles: string | null;
      personalUseAvailable: boolean | null;
      anotherVehicleAvailable: boolean | null;
      // 47a and 47b, and they are FREE: they logged their trips here, so the
      // evidence exists and it is written. Two of Part IV's six questions
      // answered by the product's own existence.
      writtenEvidence: true;
      missing: PartIVGap[];
      inconsistent: boolean;
    }[];
  };
};

// The expense accounts the standard mileage rate already absorbs: gas, repairs,
// insurance, depreciation and a lease. They land on FIVE different lines, which
// is why a guard that only watched 6100 would miss the expensive one — a §179'd
// truck on Schedule C line 13 plus standard mileage is a hard double deduction,
// and postDepreciation puts it there with nobody making a decision.
//
// Warned about, never blocked: parking and tolls are legitimately deductible on
// top of the standard rate, so a 6100 balance is not by itself an error.
const MILEAGE_OVERLAP_CODES = ['6100', '6350', '6400', '6800', '6900'] as const;

async function buildTaxWorksheet(
  tx: Transaction,
  accountId: string,
  id: string,
  q: { basis?: 'cash' | 'accrual'; year?: number; method?: 'standard' | 'actual' },
): Promise<{ error: 'company_not_found'; status: 404 } | { worksheet: TaxWorksheet }> {
  // accounting_method rides along on the company lookup — it's the basis
  // default, so we'd need the row either way. Same for the vehicle election.
  const [company] = await tx
    .select({
      id: companies.id,
      businessType: companies.businessType,
      accountingMethod: companies.accountingMethod,
      vehicleExpenseMethod: companies.vehicleExpenseMethod,
      timezone: companies.timezone,
    })
    .from(companies)
    .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
    .limit(1);
  if (!company) return { error: 'company_not_found', status: 404 };

  const form = taxFormFor(company.businessType);
  const basis = q.basis ?? (company.accountingMethod === 'accrual' ? 'accrual' : 'cash');
  // Default to the current year *where the business is* — on 1 January a US
  // operator should not still be defaulting to last year because UTC hasn't
  // rolled over, nor the reverse.
  const year = q.year ?? Number(localToday(company.timezone).slice(0, 4));
  const { from, to, toExclusiveDate } = taxYearWindow(year);
  // The tax year runs midnight-to-midnight in the company's zone: a payment
  // taken at 8pm on 31 December belongs to that year, not the next one
  // (TMC-157).
  const fromInstant = dayStartInstant(from, company.timezone);
  const toExclusiveInstant = dayStartInstant(toExclusiveDate, company.timezone);

  // Per-account net in the account's normal-balance direction, same convention
  // as profit-loss: a line on the account's normal side adds, the other side
  // subtracts. Reversal-safe by construction.
  //
  // coalesce matters: the revenue query below has no GROUP BY, so over an empty
  // window Postgres returns a single row with a NULL sum rather than zero rows
  // — and a null would reach toCents.
  const glAmount = sql<string>`coalesce(sum(case when ${journalLines.side} = ${chartOfAccounts.normalBalance} then ${journalLines.amount} else -${journalLines.amount} end), 0)::numeric(15,2)`;

  const glExpenseFilters = [
    eq(journalEntries.companyId, id),
    eq(journalEntries.accountId, accountId),
    eq(chartOfAccounts.accountType, 'expense'),
    gte(journalEntries.postedAt, fromInstant),
    lt(journalEntries.postedAt, toExclusiveInstant),
    notAClosingEntry(),
  ];
  // Cash basis: a bill's expense belongs to the period the bill was PAID, not
  // opened. Both legs of a bill (open, and any void reversal) carry
  // source_entity_type 'bill', so excluding the source wholesale keeps
  // reversals consistent, and the paid-bill query below re-adds the cash-basis
  // amount at the right date.
  if (basis === 'cash') {
    glExpenseFilters.push(ne(journalEntries.sourceEntityType, 'bill'));
  }

  const expenseRows = await tx
    .select({
      code: chartOfAccounts.code,
      name: chartOfAccounts.name,
      taxMapping: chartOfAccounts.taxMapping,
      amount: glAmount,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
    .where(and(...glExpenseFilters))
    .groupBy(chartOfAccounts.code, chartOfAccounts.name, chartOfAccounts.taxMapping)
    .orderBy(asc(chartOfAccounts.code));

  // Merge on account code so a category that received both a direct expense and
  // a paid bill lands on one line.
  const expenseByCode = new Map<string, ExpenseAccountAmount>();
  const addExpense = (row: ExpenseAccountAmount) => {
    const existing = expenseByCode.get(row.code);
    if (!existing) {
      expenseByCode.set(row.code, { ...row });
      return;
    }
    existing.amount = centsToMoney(toCents(existing.amount) + toCents(row.amount));
  };
  for (const row of expenseRows) addExpense(row);

  if (basis === 'cash') {
    const paidBills = await tx
      .select({
        code: chartOfAccounts.code,
        name: chartOfAccounts.name,
        taxMapping: chartOfAccounts.taxMapping,
        amount: sql<string>`coalesce(sum(${bills.amount}), 0)::numeric(15,2)`,
      })
      .from(bills)
      .innerJoin(chartOfAccounts, eq(bills.categoryAccountId, chartOfAccounts.id))
      .where(
        and(
          eq(bills.accountId, accountId),
          eq(bills.companyId, id),
          eq(bills.status, 'paid'),
          gte(bills.paidAt, fromInstant),
          lt(bills.paidAt, toExclusiveInstant),
        ),
      )
      .groupBy(chartOfAccounts.code, chartOfAccounts.name, chartOfAccounts.taxMapping)
      .orderBy(asc(chartOfAccounts.code));
    for (const row of paidBills) addExpense(row);
  }

  // Standard mileage (TMC-179). Bare-date comparison against the date column —
  // deliberately NOT dayStartInstant like the GL reads above. A trip date is a
  // calendar date the driver asserts, not an instant, so there is no zone to
  // resolve; job margin takes the same shortcut with invoices.issueDate.
  const trips = await tx
    .select({
      miles: mileageTrips.miles,
      tripDate: mileageTrips.tripDate,
      vehicleId: mileageTrips.vehicleId,
    })
    .from(mileageTrips)
    .where(
      and(
        eq(mileageTrips.accountId, accountId),
        eq(mileageTrips.companyId, id),
        gte(mileageTrips.tripDate, from),
        lte(mileageTrips.tripDate, to),
      ),
    );
  const mileageSummary = summariseMileage(trips);
  const vehicleMethod =
    q.method ?? (company.vehicleExpenseMethod === 'actual' ? 'actual' : 'standard');
  // Under 'actual' the trips are a record only — the deduction is the user's own
  // to compute, because this schema holds no per-vehicle expense split and no
  // business-use percentage. The figure still gets reported as `foregone` so the
  // choice can be seen rather than merely made.
  const mileageDeduction = vehicleMethod === 'standard' ? mileageSummary.amount : '0.00';

  const rollup = rollUpDeductions(
    [...expenseByCode.values()],
    form,
    standardMileageAddend(form, mileageDeduction),
  );

  // Part IV: one row per vehicle that either drove this year or has an answer
  // recorded for it. Deliberately NOT filtered on retiredAt — a truck sold in
  // June still belongs on that year's return.
  const vehicleRows = await tx
    .select({
      id: vehicles.id,
      label: vehicles.label,
      placedInServiceOn: vehicles.placedInServiceOn,
      personalUse: vehicles.personalUse,
      anotherVehicleAvailable: vehicles.anotherVehicleAvailable,
      totalMiles: vehicleYears.totalMiles,
      commutingMiles: vehicleYears.commutingMiles,
    })
    .from(vehicles)
    .leftJoin(
      vehicleYears,
      and(eq(vehicleYears.vehicleId, vehicles.id), eq(vehicleYears.taxYear, year)),
    )
    .where(and(eq(vehicles.accountId, accountId), eq(vehicles.companyId, id)))
    .orderBy(asc(vehicles.label));

  // Business miles per vehicle, from the log. Trips naming no vehicle fall out
  // of this map and are reported separately as unassigned.
  const milesByVehicle = new Map<string, { miles: string; tripDate: string }[]>();
  const unassigned: { miles: string; tripDate: string }[] = [];
  for (const t of trips) {
    if (!t.vehicleId) unassigned.push(t);
    else milesByVehicle.set(t.vehicleId, [...(milesByVehicle.get(t.vehicleId) ?? []), t]);
  }

  const vehicleInfo = {
    // 6350 is Schedule C line 13 — the exact line Part IV's header tells you to
    // check to find out whether Form 4562 is required. Already in scope.
    destination: vehicleInfoDestination(
      form,
      toCents(expenseByCode.get('6350')?.amount ?? '0.00') !== 0,
    ),
    unassignedMiles: summariseMileage(unassigned).miles,
    rows: vehicleRows.map((v) => {
      const businessMiles = summariseMileage(milesByVehicle.get(v.id) ?? []).miles;
      const commutingMiles = v.commutingMiles ?? '0.0000';
      const partIV = partIVForVehicle({
        businessMiles,
        personalUse: v.personalUse,
        placedInServiceOn: v.placedInServiceOn,
        anotherVehicleAvailable: v.anotherVehicleAvailable,
        totalMiles: v.totalMiles,
        commutingMiles,
      });
      return {
        vehicleId: v.id,
        label: v.label,
        placedInServiceOn: v.placedInServiceOn,
        businessMiles,
        commutingMiles,
        otherMiles: partIV.otherMiles,
        // A work-only vehicle's total is its business miles — known without
        // asking, which is why it needs no year row.
        totalMiles: v.personalUse === 'none' ? businessMiles : v.totalMiles,
        personalUseAvailable: v.personalUse === null ? null : v.personalUse === 'some',
        anotherVehicleAvailable: v.anotherVehicleAvailable,
        writtenEvidence: true as const,
        missing: partIV.missing,
        inconsistent: partIV.inconsistent,
      };
    }),
  };

  // What the rate already covers, off the Map that was just built. Named, not
  // netted: we cannot know which part of Repairs was the truck.
  const overlapping =
    vehicleMethod === 'standard' && toCents(mileageDeduction) > 0
      ? MILEAGE_OVERLAP_CODES.flatMap((code) => {
          const acct = expenseByCode.get(code);
          if (!acct || toCents(acct.amount) === 0) return [];
          return [{ code: acct.code, name: acct.name, amount: acct.amount }];
        })
      : [];

  // Gross receipts.
  let grossReceiptsCents: number;
  if (basis === 'cash') {
    // Direct method, and deliberately off the GL: summing cash debits would
    // also sweep in owner contributions and loan proceeds, which are cash in
    // but not revenue. Querying invoices excludes them structurally rather than
    // by blocklist. subtotal is pre-tax — sales tax collected is not income.
    // Safe against later edits because 'paid' is a terminal status, so a filed
    // year can't be retroactively altered.
    //
    // NOTE: this assumes payment is all-or-nothing (there is no partial payment
    // or deposit model today). If deposits land, this silently becomes wrong —
    // it must move to a payments table at that point. All four forms inherit
    // this.
    const [row] = await tx
      .select({
        gross: sql<string>`coalesce(sum(${invoices.subtotal}), 0)::numeric(15,2)`,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.accountId, accountId),
          eq(invoices.companyId, id),
          eq(invoices.status, 'paid'),
          gte(invoices.paidAt, fromInstant),
          lt(invoices.paidAt, toExclusiveInstant),
        ),
      );
    grossReceiptsCents = toCents(row?.gross ?? '0.00');

    // Plus revenue carried in on a conversion balance (TMC-169).
    //
    // Someone who switches to Thalermark mid-year enters what they'd already
    // traded that year as an opening trial balance, which posts straight to the
    // GL. Expenses from that entry are picked up by the query above this one —
    // it reads the GL, so it sees them on either basis. Revenue is NOT, because
    // cash-basis gross receipts come off `invoices` rather than the GL, and a
    // conversion line is not an invoice.
    //
    // Left alone, that asymmetry is the worst possible failure for this report:
    // a full year of deductions against half a year of income, on a tax
    // worksheet, silently. So the one bounded GL source that can legitimately
    // carry revenue is added back explicitly. Everything else still has to
    // arrive as an invoice, which is what keeps owner contributions and loan
    // proceeds structurally out of income.
    //
    // Basis caveat, worth knowing: we take the figures the user gives us. If
    // they kept their old books on accrual and file cash, the imported portion
    // reflects their old basis and we cannot restate it — the same number
    // appears under both lenses.
    const [converted] = await tx
      .select({ amount: glAmount })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
      .where(
        and(
          eq(journalEntries.companyId, id),
          eq(journalEntries.accountId, accountId),
          eq(chartOfAccounts.accountType, 'revenue'),
          eq(journalEntries.sourceEntityType, 'opening_balance'),
          gte(journalEntries.postedAt, fromInstant),
          lt(journalEntries.postedAt, toExclusiveInstant),
        ),
      );
    grossReceiptsCents += toCents(converted?.amount ?? '0.00');
  } else {
    const revenueRows = await tx
      .select({ amount: glAmount })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
      .where(
        and(
          eq(journalEntries.companyId, id),
          eq(journalEntries.accountId, accountId),
          eq(chartOfAccounts.accountType, 'revenue'),
          gte(journalEntries.postedAt, fromInstant),
          lt(journalEntries.postedAt, toExclusiveInstant),
          notAClosingEntry(),
        ),
      );
    grossReceiptsCents = revenueRows.reduce((sum, r) => sum + toCents(r.amount), 0);
  }

  // The income section. Returns/allowances, other income and the various
  // gain/loss lines have no data model — no refunds, no securities, no farm.
  // Cost of goods sold has none either: there is no inventory model, and the
  // seed routes materials to Supplies (matching Wave's sole-prop default), so a
  // figure entered here would double-count against that account. All emitted at
  // zero rather than omitted, so the form reads whole.
  const totalDeductionsCents = toCents(rollup.totalDeductions);
  const netIncomeCents = grossReceiptsCents - totalDeductionsCents;
  const incomeAmount = (role: string): string => {
    switch (role) {
      case 'grossReceipts':
      case 'netReceipts':
      case 'grossProfit':
      case 'totalIncome':
        return centsToMoney(grossReceiptsCents);
      default:
        return '0.00';
    }
  };

  const income: TaxLineRow[] = form.income.map((line) => ({
    ...line,
    amount: incomeAmount(line.role),
    accounts: [],
  }));

  const deductions: TaxLineRow[] = rollup.rows.map((row) => {
    if (row.role === 'totalDeductions') return { ...row, amount: rollup.totalDeductions };
    if (row.role === 'netIncome') return { ...row, amount: centsToMoney(netIncomeCents) };
    return row;
  });

  return {
    worksheet: {
      form: form.name,
      formCode: form.code,
      year,
      basis,
      // Lets the UI say "showing accrual, your saved method is cash" instead of
      // silently disagreeing with Settings.
      companyAccountingMethod: company.accountingMethod,
      from,
      to,
      income,
      deductions,
      unmappedExpenses: rollup.unmapped,
      totalDeductions: rollup.totalDeductions,
      netIncome: centsToMoney(netIncomeCents),
      mileage: {
        method: vehicleMethod,
        companyMethod: company.vehicleExpenseMethod,
        miles: mileageSummary.miles,
        amount: mileageDeduction,
        foregone: mileageSummary.amount,
        unratedMiles: mileageSummary.unratedMiles,
        tripCount: mileageSummary.tripCount,
        overlapping,
      },
      vehicleInfo,
    },
  };
}

// Projects the general worksheet back into the Schedule C response shape that
// shipped in TMC-155, for the legacy alias. Field-for-field identical to what
// mobile builds in the stores already parse — do not "improve" it.
function toLegacyScheduleC(w: TaxWorksheet) {
  const byLine = new Map(w.income.map((l) => [l.line, l.amount ?? '0.00']));
  const gross = byLine.get('1') ?? '0.00';
  return {
    year: w.year,
    basis: w.basis,
    companyAccountingMethod: w.companyAccountingMethod,
    from: w.from,
    to: w.to,
    partI: {
      grossReceipts: gross,
      returnsAndAllowances: byLine.get('2') ?? '0.00',
      netReceipts: byLine.get('3') ?? gross,
      costOfGoodsSold: byLine.get('4') ?? '0.00',
      grossProfit: byLine.get('5') ?? gross,
      otherIncome: byLine.get('6') ?? '0.00',
      grossIncome: byLine.get('7') ?? gross,
    },
    // The old shape carried only lines 8–27a here; 28/29/30/31 were separate
    // top-level fields. The generalised table folds them into `deductions`, so
    // the tail is filtered back out.
    partII: w.deductions
      .filter((r) => r.role === 'mapped')
      .map((r) => ({
        line: r.line,
        label: r.label,
        amount: r.amount ?? '0.00',
        // Non-ledger addends are folded into `accounts` here, which the old
        // shape already carried. Without this an older binary would show line 9
        // at the mileage-inclusive total with only the 6100 row beneath it and
        // no explanation of the difference. A pseudo-code rather than a real
        // one, because that IS what it is — and the shape is unchanged, which
        // is what "do not improve it" protects.
        accounts: r.computed
          ? [
              ...r.accounts,
              ...r.computed.map((c) => ({ code: 'mileage', name: c.label, amount: c.amount })),
            ]
          : r.accounts,
        ...(r.userSupplied ? { userSupplied: true as const } : {}),
      })),
    unmappedExpenses: w.unmappedExpenses,
    totalExpenses: w.totalDeductions,
    tentativeProfit: w.netIncome,
    // Line 30 has no data model. Explicitly null rather than 0.00 so the UI
    // renders "you must supply this" — a silent zero would read as "you have no
    // home office".
    homeOffice: null,
    // Line 31. Excludes line 30 by construction; the UI has to say so.
    netProfit: w.netIncome,
  };
}

// Stateless cash-flow advisor — the reasoning model is resolved per call from
// the account's credential. deps.advisor overrides it (tests inject a stub);
// otherwise the real caller is used and availability rides on the credential.
const defaultAdvisor = createCashFlowAdvisor();

export function reportsRoutes(deps: AppDeps) {
  return (
    new Hono<{ Variables: RlsVariables }>()
      // Position dashboard (slice 8.10). The product's answer surface: money
      // in, money out, what's owed — read straight off the ledger (the payoff
      // of the L1–L4 reshape). `money in/out` is cash movement over a window
      // (debits / credits on cash-like asset accounts — every asset except AR,
      // since an invoice being *sent* debits AR but that isn't cash in hand);
      // `owed` is the live AR balance, point-in-time, not period-bound. Cash
      // basis, UTC window (a per-tenant timezone is a later refinement).
      .get(
        '/api/companies/:id/dashboard',
        validator('query', (v) => ({
          period: typeof v.period === 'string' ? v.period : undefined,
          from: typeof v.from === 'string' ? v.from : undefined,
          to: typeof v.to === 'string' ? v.to : undefined,
        })),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);

          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [company] = await tx
            .select({ id: companies.id, timezone: companies.timezone })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          // Window for the in/out flows. Explicit from/to wins (L4-style, for
          // deterministic callers + tests); otherwise a named period, default
          // this month. Upper bound is half-open on the day after `to` so the
          // last day is fully included (matches the ledger export).
          const { period: periodRaw, from: fromRaw, to: toRaw } = c.req.valid('query');
          const period = periodRaw ?? 'month';
          // Calendar-date arithmetic first, instants second: "this month" means
          // the operator's month, and its edges resolve through the company's
          // zone (TMC-157).
          const today = localToday(company.timezone);
          let from: string;
          let to: string;
          if (fromRaw !== undefined || toRaw !== undefined) {
            if (!fromRaw || Number.isNaN(Date.parse(`${fromRaw}T00:00:00Z`))) {
              return c.json({ error: 'invalid_from' }, 400);
            }
            if (!toRaw || Number.isNaN(Date.parse(`${toRaw}T00:00:00Z`))) {
              return c.json({ error: 'invalid_to' }, 400);
            }
            if (fromRaw > toRaw) return c.json({ error: 'invalid_range' }, 400);
            from = fromRaw;
            to = toRaw;
          } else {
            to = today;
            if (period === 'month') {
              from = `${today.slice(0, 7)}-01`;
            } else if (period === '30d') {
              from = addDays(today, -29);
            } else if (period === 'ytd') {
              from = `${today.slice(0, 4)}-01-01`;
            } else {
              return c.json({ error: 'invalid_period' }, 400);
            }
          }
          const fromInstant = dayStartInstant(from, company.timezone);
          const toExclusiveInstant = dayStartInstant(addDays(to, 1), company.timezone);

          // Reversal-safe cash flow + live AR balance (shared with cash-flow
          // nudges) — see cashFlowNet / arBalance in lib/ledger.ts. Netting per
          // source means expense edits/voids don't inflate the flows (#144).
          const cash = await cashFlowNet(tx, {
            accountId,
            companyId: id,
            fromDate: fromInstant,
            toExclusive: toExclusiveInstant,
          });
          const owed = await arBalance(tx, { accountId, companyId: id });
          // `owing` completes the in/out/owed/owing quadrant — the live AP
          // balance (what's owed to vendors via open bills), point-in-time like
          // `owed`. Zero until the first bill is recorded.
          const owing = await apBalance(tx, { accountId, companyId: id });

          return c.json({
            moneyIn: cash.moneyIn,
            moneyOut: cash.moneyOut,
            owed,
            owing,
            from,
            to,
          });
        },
      )
      // Top-products report (slice I5) — the payoff of the source_item_id
      // breadcrumb. A deterministic GROUP BY source_item_id aggregate over
      // invoice line items (SUM(amount), COUNT(*)); no second datastore. This
      // is a management/sales lens, explicitly NOT GL-reconciled: line amounts
      // are pre-tax, and a single "Uncatalogued / other" bucket (NULL-source
      // lines, identified by sourceItemId === null) collects hand-typed lines
      // so product rows + the bucket tie back to GL revenue on a matched basis.
      // `basis` states what counts: 'paid' (cash — paid invoices only, the
      // default) or 'sent' (sent or paid, voided/draft excluded). Archived
      // items keep their name via the left join, so the report never loses
      // history. Catalogued rows sort by revenue desc; the bucket sorts last.
      .get(
        '/api/companies/:id/top-products',
        // validator types `query` for the hc<AppType>() client (same reason as
        // the dashboard route) and rejects an unknown basis with a clean 400.
        validator('query', (v, c) => {
          const basis = v.basis;
          if (basis !== undefined && basis !== 'paid' && basis !== 'sent') {
            return c.json({ error: 'invalid_basis' }, 400);
          }
          return { basis: (basis ?? 'paid') as 'paid' | 'sent' };
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);

          const { basis } = c.req.valid('query');

          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [company] = await tx
            .select({ id: companies.id, timezone: companies.timezone })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          const statusFilter =
            basis === 'paid'
              ? eq(invoices.status, 'paid')
              : inArray(invoices.status, ['sent', 'paid']);

          const rows = await tx
            .select({
              sourceItemId: invoiceLineItems.sourceItemId,
              name: items.name,
              revenue: sql<string>`sum(${invoiceLineItems.amount})::numeric(15,2)`,
              lineCount: sql<number>`count(*)::int`,
            })
            .from(invoiceLineItems)
            .innerJoin(invoices, eq(invoices.id, invoiceLineItems.invoiceId))
            .leftJoin(items, eq(items.id, invoiceLineItems.sourceItemId))
            .where(
              and(
                eq(invoiceLineItems.accountId, accountId),
                eq(invoices.accountId, accountId),
                eq(invoices.companyId, id),
                statusFilter,
              ),
            )
            .groupBy(invoiceLineItems.sourceItemId, items.name)
            // Uncatalogued bucket (null source) sorts last; products by revenue.
            .orderBy(
              sql`(${invoiceLineItems.sourceItemId} is null) asc, sum(${invoiceLineItems.amount}) desc`,
            );

          const mapped = rows.map((r) => ({
            sourceItemId: r.sourceItemId,
            name: r.name,
            revenue: r.revenue ?? '0.00',
            lineCount: r.lineCount,
          }));
          // Top 25 catalogued products by revenue, plus the single
          // "Uncatalogued / other" bucket (hand-typed lines) appended as
          // context — it's an "other" row, not a product, so it doesn't consume
          // a slot in the top 25. Slicing in app code (rows are already ordered
          // products-first, bucket-last) keeps the bucket regardless of how many
          // products there are; a bare LIMIT would drop it.
          const TOP_N = 25;
          const products = mapped.filter((p) => p.sourceItemId !== null).slice(0, TOP_N);
          const bucket = mapped.filter((p) => p.sourceItemId === null);
          return c.json({ basis, products: [...products, ...bucket] });
        },
      )
      // Profit & Loss report (the tax set). Accrual income statement read
      // straight off the GL: revenue + expense accounts, summed in their
      // normal-balance direction over a [from, to] window (inclusive, to+1 day
      // exclusive on the upper bound — same convention as the ledger export and
      // dashboard). Default window is year-to-date. Each account's signed net
      // (per-account window sum) is reversal-safe by construction: a void/edit
      // posts a reversing entry that flips the sign, so an in-window correction
      // nets out and a cross-period one lands in the period it was posted (real
      // accrual behavior) — no per-source netting like cashFlowNet needs.
      // taxMapping (Schedule C line) rides along so the expense breakdown
      // doubles as a tax-prep view. Powers both /reports/profit-and-loss and
      // /reports/expenses-by-category (the expense section).
      .get(
        '/api/companies/:id/profit-loss',
        validator('query', (v) => ({
          from: typeof v.from === 'string' ? v.from : undefined,
          to: typeof v.to === 'string' ? v.to : undefined,
        })),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);

          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [company] = await tx
            .select({ id: companies.id, timezone: companies.timezone })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          const { from: fromRaw, to: toRaw } = c.req.valid('query');
          const win = parseReportWindow(fromRaw, toRaw, company.timezone);
          if ('error' in win) return c.json({ error: win.error }, 400);
          const { fromInstant, toExclusiveInstant, from, to } = win;

          // Per-account net in the account's normal-balance direction: when a
          // line's side matches the account's normal_balance it adds, else it
          // subtracts. Revenue (credit-normal) => credit−debit; expense
          // (debit-normal) => debit−credit.
          const rows = await tx
            .select({
              code: chartOfAccounts.code,
              name: chartOfAccounts.name,
              accountType: chartOfAccounts.accountType,
              taxMapping: chartOfAccounts.taxMapping,
              amount: sql<string>`sum(case when ${journalLines.side} = ${chartOfAccounts.normalBalance} then ${journalLines.amount} else -${journalLines.amount} end)::numeric(15,2)`,
            })
            .from(journalLines)
            .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
            .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
            .where(
              and(
                eq(journalEntries.companyId, id),
                eq(journalEntries.accountId, accountId),
                inArray(chartOfAccounts.accountType, ['revenue', 'expense']),
                gte(journalEntries.postedAt, fromInstant),
                lt(journalEntries.postedAt, toExclusiveInstant),
                notAClosingEntry(),
              ),
            )
            .groupBy(
              chartOfAccounts.code,
              chartOfAccounts.name,
              chartOfAccounts.accountType,
              chartOfAccounts.taxMapping,
            )
            .orderBy(asc(chartOfAccounts.code));

          type Line = { code: string; name: string; taxMapping: string | null; amount: string };
          const revenue: Line[] = [];
          const expenses: Line[] = [];
          let totalRevenueCents = 0;
          let totalExpensesCents = 0;
          for (const r of rows) {
            const amtCents = toCents(r.amount);
            // Drop accounts that net to zero in the window (e.g. a sale fully
            // voided in-period) so the statement isn't cluttered with no-ops.
            if (amtCents === 0) continue;
            const line: Line = {
              code: r.code,
              name: r.name,
              taxMapping: r.taxMapping,
              amount: r.amount,
            };
            if (r.accountType === 'revenue') {
              revenue.push(line);
              totalRevenueCents += amtCents;
            } else {
              expenses.push(line);
              totalExpensesCents += amtCents;
            }
          }

          return c.json({
            from,
            to,
            revenue,
            expenses,
            totalRevenue: centsToMoney(totalRevenueCents),
            totalExpenses: centsToMoney(totalExpensesCents),
            netProfit: centsToMoney(totalRevenueCents - totalExpensesCents),
          });
        },
      )
      // Tax worksheet (TMC-155 for Schedule C, TMC-162 for the other three) —
      // the accountant handoff. Not a filing: a form-shaped view the user hands
      // over or types into consumer tax software. The COA already carries the
      // mapping (chart_of_accounts.tax_mapping, seeded per account against the
      // return that entity actually files), so this groups by tax line instead
      // of by account code and fills the rest of the form's skeleton.
      //
      // One endpoint, four forms: which one you get is dispatched off the
      // company's business type, so clients never route by entity type. See
      // lib/tax-worksheet.ts for the line tables.
      //
      // Basis is the interesting part. The GL is *always* accrual — that's what
      // double-entry is — so cash basis is a reporting lens applied at read
      // time, the same one-ledger model QuickBooks and Xero use. Defaults to
      // the company's accounting_method (itself defaulting to cash, which is
      // how effectively every sole proprietor files); ?basis= overrides for a
      // side-by-side look without changing the stored election.
      //
      //   accrual — read straight off the GL, same query shape as profit-loss.
      //   cash    — gross receipts from invoices actually PAID in the window
      //             (direct method: query what was paid, rather than the
      //             textbook indirect "accrual revenue − ΔAR"; our invoice-level
      //             paid state is clean, so this is the more accurate of the
      //             two). Expenses already post Dr expense / Cr cash at spend
      //             time, so they're cash-basis already — except bills, which
      //             post Dr expense / Cr AP when *opened*. So we drop
      //             bill-sourced GL postings and add back bills paid in-window
      //             against their original category.
      .get('/api/companies/:id/tax-worksheet', validator('query', taxWorksheetQuery), async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const q = c.req.valid('query');
        if ('error' in q) return c.json({ error: q.error }, 400);

        const built = await buildTaxWorksheet(c.get('tx'), c.get('accountId'), id, q);
        if ('error' in built) return c.json({ error: built.error }, built.status);
        return c.json(built.worksheet);
      })
      // Legacy alias, kept because mobile ships through the app stores and an
      // older binary must not 404 on upgrade. Deliberately reproduces the OLD
      // response shape byte for byte — partI/partII/homeOffice/netProfit, and
      // the 409 for a business that doesn't file a Schedule C — rather than
      // returning the general shape a shipped client can't read. One
      // computation, two projections: the SQL below runs once either way.
      //
      // Retire once the store-minimum app version is past the TMC-162 release.
      .get('/api/companies/:id/schedule-c', validator('query', taxWorksheetQuery), async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const q = c.req.valid('query');
        if ('error' in q) return c.json({ error: q.error }, 400);

        const built = await buildTaxWorksheet(c.get('tx'), c.get('accountId'), id, q);
        if ('error' in built) return c.json({ error: built.error }, built.status);
        const { worksheet } = built;
        if (worksheet.formCode !== 'schedule_c') {
          return c.json({ error: 'wrong_tax_form', taxForm: worksheet.form }, 409);
        }
        return c.json(toLegacyScheduleC(worksheet));
      })
      // Sales by customer (insight set). Pre-tax sales (subtotal) per customer
      // for invoices issued in the window, sent or paid (drafts + voided
      // excluded). Top 25 by sales; the grand total sums ALL contacts (computed
      // from the full result, sliced in app code) so "Top 25 of $X" is honest.
      .get(
        '/api/companies/:id/sales-by-customer',
        validator('query', (v) => ({
          from: typeof v.from === 'string' ? v.from : undefined,
          to: typeof v.to === 'string' ? v.to : undefined,
        })),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const [company] = await tx
            .select({ id: companies.id, timezone: companies.timezone })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          const { from: fromRaw, to: toRaw } = c.req.valid('query');
          const win = parseReportWindow(fromRaw, toRaw, company.timezone);
          if ('error' in win) return c.json({ error: win.error }, 400);

          const rows = await tx
            .select({
              contactId: invoices.contactId,
              name: contacts.name,
              sales: sql<string>`sum(${invoices.subtotal})::numeric(15,2)`,
              invoiceCount: sql<number>`count(*)::int`,
            })
            .from(invoices)
            .leftJoin(contacts, eq(contacts.id, invoices.contactId))
            .where(
              and(
                eq(invoices.accountId, accountId),
                eq(invoices.companyId, id),
                inArray(invoices.status, ['sent', 'paid']),
                gte(invoices.issueDate, win.from),
                lte(invoices.issueDate, win.to),
              ),
            )
            .groupBy(invoices.contactId, contacts.name)
            .orderBy(sql`sum(${invoices.subtotal}) desc`);

          const totalSales = sumMoney(rows.map((r) => r.sales ?? '0'));
          return c.json({
            from: win.from,
            to: win.to,
            contacts: rows.slice(0, 25).map((r) => ({
              contactId: r.contactId,
              name: r.name,
              sales: r.sales ?? '0.00',
              invoiceCount: r.invoiceCount,
            })),
            totalSales,
          });
        },
      )
      // Revenue over time (insight set). Pre-tax sales per calendar month for
      // invoices issued in the window, sent or paid. Months with no sales are
      // simply absent (the web page fills the gaps for a continuous trend).
      .get(
        '/api/companies/:id/revenue-over-time',
        validator('query', (v) => ({
          from: typeof v.from === 'string' ? v.from : undefined,
          to: typeof v.to === 'string' ? v.to : undefined,
        })),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const [company] = await tx
            .select({ id: companies.id, timezone: companies.timezone })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          const { from: fromRaw, to: toRaw } = c.req.valid('query');
          const win = parseReportWindow(fromRaw, toRaw, company.timezone);
          if ('error' in win) return c.json({ error: win.error }, 400);

          const monthExpr = sql<string>`to_char(date_trunc('month', ${invoices.issueDate}::date), 'YYYY-MM')`;
          const rows = await tx
            .select({
              month: monthExpr,
              revenue: sql<string>`sum(${invoices.subtotal})::numeric(15,2)`,
            })
            .from(invoices)
            .where(
              and(
                eq(invoices.accountId, accountId),
                eq(invoices.companyId, id),
                inArray(invoices.status, ['sent', 'paid']),
                gte(invoices.issueDate, win.from),
                lte(invoices.issueDate, win.to),
              ),
            )
            .groupBy(monthExpr)
            .orderBy(monthExpr);

          const total = sumMoney(rows.map((r) => r.revenue ?? '0'));
          return c.json({
            from: win.from,
            to: win.to,
            months: rows.map((r) => ({ month: r.month, revenue: r.revenue ?? '0.00' })),
            total,
          });
        },
      )
      // Estimate win rate (insight set). Estimate counts + pre-tax value grouped
      // by status for estimates issued in the window. Win rate = accepted /
      // (accepted + declined + expired) by count — "decided" excludes still-open
      // draft/sent. Null when nothing has been decided yet.
      .get(
        '/api/companies/:id/estimate-win-rate',
        validator('query', (v) => ({
          from: typeof v.from === 'string' ? v.from : undefined,
          to: typeof v.to === 'string' ? v.to : undefined,
        })),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const [company] = await tx
            .select({ id: companies.id, timezone: companies.timezone })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          const { from: fromRaw, to: toRaw } = c.req.valid('query');
          const win = parseReportWindow(fromRaw, toRaw, company.timezone);
          if ('error' in win) return c.json({ error: win.error }, 400);

          const rows = await tx
            .select({
              status: estimates.status,
              count: sql<number>`count(*)::int`,
              value: sql<string>`sum(${estimates.subtotal})::numeric(15,2)`,
            })
            .from(estimates)
            .where(
              and(
                eq(estimates.accountId, accountId),
                eq(estimates.companyId, id),
                gte(estimates.issueDate, win.from),
                lte(estimates.issueDate, win.to),
              ),
            )
            .groupBy(estimates.status);

          // Normalize to a fixed status set (zeros for absent statuses) so the
          // page renders consistently.
          const STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired'] as const;
          const byCode = new Map(rows.map((r) => [r.status, r]));
          const byStatus = STATUSES.map((status) => {
            const row = byCode.get(status);
            return { status, count: row?.count ?? 0, value: row?.value ?? '0.00' };
          });
          const countFor = (s: string) => byStatus.find((b) => b.status === s)?.count ?? 0;
          const accepted = countFor('accepted');
          const decided = accepted + countFor('declined') + countFor('expired');
          return c.json({
            from: win.from,
            to: win.to,
            byStatus,
            acceptedCount: accepted,
            decidedCount: decided,
            // 4-dp ratio (e.g. "0.6667"); null when nothing decided yet.
            winRate: decided > 0 ? (accepted / decided).toFixed(4) : null,
          });
        },
      )
      // Balance sheet (the other primary financial statement, paired with P&L).
      // Point-in-time: every account's signed balance as of a date. The books
      // are never closed, so revenue − expenses through the as-of date is folded
      // into equity as a "Retained earnings" line — that's what makes
      // Assets = Liabilities + Equity hold (it follows directly from the trial
      // balance always balancing: Assets+Expenses = Liabilities+Equity+Revenue).
      .get(
        '/api/companies/:id/balance-sheet',
        validator('query', (v) => ({ asOf: typeof v.asOf === 'string' ? v.asOf : undefined })),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const [company] = await tx
            .select({ id: companies.id, timezone: companies.timezone })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          const parsed = parseAsOf(c.req.valid('query').asOf, company.timezone);
          if ('error' in parsed) return c.json({ error: parsed.error }, 400);
          const { asOf, asOfExclusiveInstant } = parsed;

          const rows = await tx
            .select({
              code: chartOfAccounts.code,
              name: chartOfAccounts.name,
              accountType: chartOfAccounts.accountType,
              amount: sql<string>`sum(case when ${journalLines.side} = ${chartOfAccounts.normalBalance} then ${journalLines.amount} else -${journalLines.amount} end)::numeric(15,2)`,
            })
            .from(journalLines)
            .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
            .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
            .where(
              and(
                eq(journalEntries.companyId, id),
                eq(journalEntries.accountId, accountId),
                lt(journalEntries.postedAt, asOfExclusiveInstant),
              ),
            )
            .groupBy(chartOfAccounts.code, chartOfAccounts.name, chartOfAccounts.accountType)
            .orderBy(asc(chartOfAccounts.code));

          type Line = { code: string; name: string; amount: string };
          const assets: Line[] = [];
          const liabilities: Line[] = [];
          const equity: Line[] = [];
          let totalAssetsCents = 0;
          let totalLiabilitiesCents = 0;
          let equitySumCents = 0;
          let revenueSumCents = 0;
          let expenseSumCents = 0;
          for (const r of rows) {
            const amtCents = toCents(r.amount);
            if (amtCents === 0) continue;
            const line: Line = { code: r.code, name: r.name, amount: r.amount };
            if (r.accountType === 'asset') {
              assets.push(line);
              totalAssetsCents += amtCents;
            } else if (r.accountType === 'liability') {
              liabilities.push(line);
              totalLiabilitiesCents += amtCents;
            } else if (r.accountType === 'equity') {
              equity.push(line);
              equitySumCents += amtCents;
            } else if (r.accountType === 'revenue') {
              revenueSumCents += amtCents;
            } else {
              expenseSumCents += amtCents;
            }
          }
          // Net income (retained earnings while the books stay open) closes the
          // identity: Assets = Liabilities + (explicit equity + net income).
          const netIncomeCents = revenueSumCents - expenseSumCents;
          const totalEquityCents = equitySumCents + netIncomeCents;
          const totalLiabilitiesAndEquityCents = totalLiabilitiesCents + totalEquityCents;
          return c.json({
            asOf,
            assets,
            liabilities,
            equity,
            netIncome: centsToMoney(netIncomeCents),
            totalAssets: centsToMoney(totalAssetsCents),
            totalLiabilities: centsToMoney(totalLiabilitiesCents),
            totalEquity: centsToMoney(totalEquityCents),
            totalLiabilitiesAndEquity: centsToMoney(totalLiabilitiesAndEquityCents),
            // True by construction (every entry balances); surfaced as an
            // integrity check — a false here means the ledger has drifted. Exact
            // in the cents domain, so this is a strict equality, not an epsilon.
            balanced: totalAssetsCents === totalLiabilitiesAndEquityCents,
          });
        },
      )
      // A/R aging (getting-paid set). Currently-outstanding invoices (status
      // 'sent' — issued but unpaid; no partial payments in MVP, so the owed
      // amount is the invoice total) bucketed by days past due relative to the
      // as-of date. The total ties to the AR ledger balance.
      .get(
        '/api/companies/:id/ar-aging',
        validator('query', (v) => ({ asOf: typeof v.asOf === 'string' ? v.asOf : undefined })),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const [company] = await tx
            .select({ id: companies.id, timezone: companies.timezone })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          const parsed = parseAsOf(c.req.valid('query').asOf, company.timezone);
          if ('error' in parsed) return c.json({ error: parsed.error }, 400);
          const { asOf } = parsed;

          const rows = await tx
            .select({
              id: invoices.id,
              number: invoices.number,
              customerName: contacts.name,
              dueDate: invoices.dueDate,
              total: invoices.total,
            })
            .from(invoices)
            .leftJoin(contacts, eq(contacts.id, invoices.contactId))
            .where(
              and(
                eq(invoices.accountId, accountId),
                eq(invoices.companyId, id),
                eq(invoices.status, 'sent'),
              ),
            );

          // Days past due = asOf − dueDate (both bare dates, UTC midnight). A
          // negative value = not yet due → the "current" bucket.
          const asOfMs = new Date(`${asOf}T00:00:00Z`).getTime();
          const BUCKETS = [
            { key: 'current', label: 'Current', min: Number.NEGATIVE_INFINITY, max: 0 },
            { key: '1-30', label: '1–30 days', min: 1, max: 30 },
            { key: '31-60', label: '31–60 days', min: 31, max: 60 },
            { key: '61-90', label: '61–90 days', min: 61, max: 90 },
            { key: '90+', label: '90+ days', min: 91, max: Number.POSITIVE_INFINITY },
          ];
          // amount is accumulated in integer cents (formatted on the way out).
          const bucketTotals = new Map(BUCKETS.map((b) => [b.key, { count: 0, amountCents: 0 }]));
          const outstanding = rows
            .map((r) => {
              const dueMs = new Date(`${r.dueDate}T00:00:00Z`).getTime();
              const daysPastDue = Math.round((asOfMs - dueMs) / 86_400_000);
              const bucket = BUCKETS.find((b) => daysPastDue >= b.min && daysPastDue <= b.max);
              const key = bucket?.key ?? 'current';
              const agg = bucketTotals.get(key);
              if (agg) {
                agg.count += 1;
                agg.amountCents += toCents(r.total);
              }
              return {
                id: r.id,
                number: r.number,
                customerName: r.customerName,
                dueDate: r.dueDate,
                daysPastDue,
                amount: r.total,
              };
            })
            // Most overdue first.
            .sort((a, b) => b.daysPastDue - a.daysPastDue);

          const total = sumMoney(outstanding.map((r) => r.amount));
          return c.json({
            asOf,
            buckets: BUCKETS.map((b) => {
              const agg = bucketTotals.get(b.key);
              return {
                key: b.key,
                label: b.label,
                count: agg?.count ?? 0,
                amount: centsToMoney(agg?.amountCents ?? 0),
              };
            }),
            invoices: outstanding,
            total,
          });
        },
      )
      // Sales tax collected (getting-paid set). Net movement on Sales Tax
      // Payable (COA 2200, per SOLE_PROP_COA) over the window — sent invoices
      // credit it, voids debit it, so credit−debit is tax owed to the state for
      // the period. Bucketed by the month the posting landed (mark-sent time).
      .get(
        '/api/companies/:id/sales-tax',
        validator('query', (v) => ({
          from: typeof v.from === 'string' ? v.from : undefined,
          to: typeof v.to === 'string' ? v.to : undefined,
        })),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const [company] = await tx
            .select({ id: companies.id, timezone: companies.timezone })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          const { from: fromRaw, to: toRaw } = c.req.valid('query');
          const win = parseReportWindow(fromRaw, toRaw, company.timezone);
          if ('error' in win) return c.json({ error: win.error }, 400);

          const monthExpr = localMonthExpr(journalEntries.postedAt, company.timezone);
          const rows = await tx
            .select({
              month: monthExpr,
              collected: sql<string>`sum(case when ${journalLines.side} = 'credit' then ${journalLines.amount} else -${journalLines.amount} end)::numeric(15,2)`,
            })
            .from(journalLines)
            .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
            .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
            .where(
              and(
                eq(journalEntries.companyId, id),
                eq(journalEntries.accountId, accountId),
                eq(chartOfAccounts.code, '2200'),
                gte(journalEntries.postedAt, win.fromInstant),
                lt(journalEntries.postedAt, win.toExclusiveInstant),
              ),
            )
            // Group/order by ordinal, not by repeating monthExpr. The timezone
            // is a bound parameter, so re-emitting the expression here would
            // give it a *different* parameter number than the one in SELECT —
            // and Postgres matches GROUP BY to SELECT structurally, so $9 and
            // $1 don't count as the same expression however identical the rest
            // of the text is. Position 1 is the month column by construction.
            .groupBy(sql`1`)
            .orderBy(sql`1`);

          const total = centsToMoney(rows.reduce((s, r) => s + toCents(r.collected ?? '0'), 0));
          return c.json({
            from: win.from,
            to: win.to,
            months: rows.map((r) => ({ month: r.month, collected: r.collected ?? '0.00' })),
            total,
          });
        },
      )
      // Cash-flow nudges (AI insight). Deterministic ledger signals computed
      // here (the LLM never does ledger arithmetic); the reasoning-model
      // advisor only narrates them into <=3 plain-English nudges. Cached on the
      // company row + regenerated only when the signals' hash changes (new
      // activity, a newly-overdue invoice, a month rollover) — so a quiet
      // dashboard reload returns the cached text with no model call. Opt-in
      // like the other AI routes: 503 only when there's no advisor AND nothing
      // cached. The cache write on a GET is deliberate read-through memoisation.
      .get(
        '/api/companies/:id/cash-flow-nudges',
        requireEntitlement(deps, 'ai'),
        rateLimit(deps, RATE_LIMITS.ai, (c) => c.get('accountId') as string | undefined),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);

          const accountId = c.get('accountId');
          // This account's LLM credential (managed or its own BYOK key). Resolved
          // but not gated yet: a cache hit below serves cached nudges even with no
          // usable key; only a cache MISS with no credential 503s.
          const credential = await resolveAccountCredential(deps, accountId);

          // tx1: load the cache + compute the deterministic ledger signals, then
          // release the connection before the model call (deferred-tx route, see
          // rls-context).
          const prep = await c.var.runInTx(async (tx) => {
            const [company] = await tx
              .select({
                id: companies.id,
                businessType: companies.businessType,
                cachedNudges: companies.cashFlowNudges,
                cachedHash: companies.nudgesInputHash,
                generatedAt: companies.nudgesGeneratedAt,
              })
              .from(companies)
              .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
              .limit(1);
            if (!company) return null;

            // Window math (UTC, half-open upper bounds). MTD = month start → tomorrow;
            // trailing = the 3 prior full calendar months (Date.UTC handles year
            // underflow). overdue = sent invoices whose due date has passed.
            const now = new Date();
            const y = now.getUTCFullYear();
            const m = now.getUTCMonth();
            const d = now.getUTCDate();
            const todayYmd = now.toISOString().slice(0, 10);
            const monthStart = new Date(Date.UTC(y, m, 1));
            const tomorrow = new Date(Date.UTC(y, m, d + 1));

            const scope = { accountId, companyId: id };
            const monthToDate = await cashFlowNet(tx, {
              ...scope,
              fromDate: monthStart,
              toExclusive: tomorrow,
            });
            const trailingMonths: CashFlowSignals['trailingMonths'] = [];
            for (let k = 3; k >= 1; k--) {
              const start = new Date(Date.UTC(y, m - k, 1));
              const end = new Date(Date.UTC(y, m - k + 1, 1));
              const flow = await cashFlowNet(tx, { ...scope, fromDate: start, toExclusive: end });
              trailingMonths.push({
                month: start.toISOString().slice(0, 7),
                moneyIn: flow.moneyIn,
                moneyOut: flow.moneyOut,
              });
            }
            const [overdue] = await tx
              .select({ count: sql<number>`count(*)::int` })
              .from(invoices)
              .where(
                and(
                  eq(invoices.accountId, accountId),
                  eq(invoices.companyId, id),
                  eq(invoices.status, 'sent'),
                  lt(invoices.dueDate, todayYmd),
                ),
              );

            const signals: CashFlowSignals = {
              asOf: todayYmd,
              cashOnHand: await cashOnHand(tx, scope),
              monthToDate,
              trailingMonths,
              owed: await arBalance(tx, scope),
              overdueCount: overdue?.count ?? 0,
              // Set unconditionally, and last. It is hashed with the rest of the
              // signals, so a conditional spread would drop the key for
              // null-business-type companies and quietly restore their old cache
              // key; the insertion order is likewise part of the hashed JSON.
              businessType: company.businessType,
            };
            // Version-tag the cache key so a prompt/advisor change (CASH_FLOW_NUDGE_VERSION)
            // regenerates cached nudges — the signals hash alone wouldn't change.
            const hash = createHash('sha256')
              .update(JSON.stringify({ v: CASH_FLOW_NUDGE_VERSION, signals }))
              .digest('hex');
            return {
              cachedNudges: company.cachedNudges,
              cachedHash: company.cachedHash,
              cachedGeneratedAt: company.generatedAt,
              signals,
              hash,
            };
          });
          if (!prep) return c.json({ error: 'company_not_found' }, 404);
          const { cachedNudges, cachedHash, cachedGeneratedAt, signals, hash } = prep;

          // Cache hit: signals unchanged since the last generation → no model call.
          if (cachedNudges && cachedHash === hash) {
            return c.json({
              nudges: cachedNudges,
              generatedAt: cachedGeneratedAt?.toISOString() ?? null,
            });
          }

          // No usable credential for this account: serve stale cache if we have
          // it, else 503 — same shape as the old advisor-null branch.
          if (!credential) {
            if (cachedNudges) {
              return c.json({
                nudges: cachedNudges,
                generatedAt: cachedGeneratedAt?.toISOString() ?? null,
              });
            }
            return c.json({ error: 'ai_not_configured' }, 503);
          }

          // Cache miss: regenerate (no DB connection held), persist, return. A
          // model failure leaves the old cache intact and surfaces 502 (the
          // streamed UI shows nothing).
          const advisor = deps.advisor ?? defaultAdvisor;
          let nudges: Awaited<ReturnType<CashFlowAdvisor['advise']>>;
          try {
            nudges = await advisor.advise(signals, credential);
          } catch (err) {
            await recordLlmCallHealth(deps.llmConnections, accountId, credential, err);
            return c.json({ error: 'nudges_failed' }, 502);
          }
          // Success → clear any prior error, state-change-only.
          await recordLlmCallHealth(deps.llmConnections, accountId, credential);
          const generatedAt = new Date();
          // tx2: persist the regenerated cache.
          await c.var.runInTx(async (tx) => {
            await tx
              .update(companies)
              .set({
                cashFlowNudges: nudges,
                nudgesInputHash: hash,
                nudgesGeneratedAt: generatedAt,
              })
              .where(and(eq(companies.id, id), eq(companies.accountId, accountId)));
          });

          return c.json({ nudges, generatedAt: generatedAt.toISOString() });
        },
      )
      // Anomaly flagging (AI-layer insight, deterministic): unusual spending vs
      // the customer's own history. Computed straight from the expenses table
      // (edits update the row in place, deletes set deleted_at — so summing
      // `amount` where deleted_at is null is the correct current total, no
      // ledger-reversal handling needed). Rolling windows avoid the partial-
      // calendar-month trap: `recent` = last 30 days; `baseline` = the 90 days
      // before that, averaged to a per-30-day figure ("your typical month").
      // Flags overall spend and per-category spikes; the % + a min-dollar floor
      // suppress noise on tiny categories. No LLM — the numbers are the insight.
      .get('/api/companies/:id/spending-anomalies', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [company] = await tx
          .select({ id: companies.id, timezone: companies.timezone })
          .from(companies)
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        // Window boundaries as YYYY-MM-DD (ISO strings sort chronologically, so
        // string comparison on the bare `expense_date` column is correct).
        const now = new Date();
        const dayMs = 86_400_000;
        const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
        const today = ymd(now.getTime());
        const recentStart = ymd(now.getTime() - 29 * dayMs); // last 30 days incl. today
        const baselineEnd = ymd(now.getTime() - 30 * dayMs); // day before the recent window
        const baselineStart = ymd(now.getTime() - 119 * dayMs); // 90 days before that

        const rows = await tx
          .select({
            code: chartOfAccounts.code,
            name: chartOfAccounts.name,
            recent: sql<string>`coalesce(sum(${expenses.amount}) filter (where ${expenses.expenseDate} >= ${recentStart}), 0)`,
            baseline: sql<string>`coalesce(sum(${expenses.amount}) filter (where ${expenses.expenseDate} <= ${baselineEnd}), 0)`,
          })
          .from(expenses)
          .innerJoin(chartOfAccounts, eq(expenses.categoryAccountId, chartOfAccounts.id))
          .where(
            and(
              eq(expenses.accountId, accountId),
              eq(expenses.companyId, id),
              isNull(expenses.deletedAt),
              gte(expenses.expenseDate, baselineStart),
              lte(expenses.expenseDate, today),
            ),
          )
          .groupBy(chartOfAccounts.id, chartOfAccounts.code, chartOfAccounts.name);

        // Thresholds: overall flags at +40% over the typical month; a category
        // needs +50% AND at least $50 of recent spend so a tiny line doesn't
        // shout. baseline is divided by 3 (three 30-day windows) to a per-month
        // average.
        const OVERALL_OVER = 0.4;
        const CATEGORY_OVER = 0.5;
        const CATEGORY_MIN_RECENT = 50;

        let recentTotal = 0;
        let baselineTotal = 0;
        const categories: {
          code: string;
          name: string;
          recent: string;
          typical: string;
          pctOver: number;
        }[] = [];
        for (const r of rows) {
          const recent = Number(r.recent);
          const typical = Number(r.baseline) / 3;
          recentTotal += recent;
          baselineTotal += Number(r.baseline);
          if (
            typical > 0 &&
            recent >= typical * (1 + CATEGORY_OVER) &&
            recent >= CATEGORY_MIN_RECENT
          ) {
            categories.push({
              code: r.code,
              name: r.name,
              recent: recent.toFixed(2),
              typical: typical.toFixed(2),
              pctOver: Math.round((recent / typical - 1) * 100),
            });
          }
        }
        categories.sort((a, b) => b.pctOver - a.pctOver);

        const typicalTotal = baselineTotal / 3;
        const enoughHistory = baselineTotal > 0;
        const overall =
          enoughHistory && recentTotal >= typicalTotal * (1 + OVERALL_OVER)
            ? {
                recent: recentTotal.toFixed(2),
                typical: typicalTotal.toFixed(2),
                pctOver: Math.round((recentTotal / typicalTotal - 1) * 100),
              }
            : null;

        return c.json({ enoughHistory, overall, categories: categories.slice(0, 5) });
      })
      // Job margin (TMC-174) — what each job made, plus the shared pool.
      //
      // The invoice IS the job: no jobs entity exists and none is wanted here.
      // Rows are labelled with the customer's name so the list reads the way the
      // user talks ("the Smith job") while being invoices underneath.
      //
      // Billed is the SUBTOTAL. Sales tax he collects is not his money, and
      // counting it would inflate every taxed job.
      //
      // Three buckets, and the last two are why this report can be honest:
      //   - per-job: costs the user attributed to that invoice
      //   - shared: costs he deliberately declined to attribute (invoice_id
      //     null). Shown as its own line, NEVER apportioned across jobs —
      //     inventing a split he did not give is a lie that looks like a fact.
      //   - unattributed: costs he never answered for at all. Distinct from
      //     shared, and surfaced so the totals reconcile rather than quietly
      //     disagreeing with the P&L.
      //
      // Window is on the INVOICE issue date, matching revenue recognition; a
      // cost attributed to a job outside the window still counts toward it,
      // because the job is the unit here, not the month.
      .get(
        '/api/companies/:id/job-margin',
        validator('query', (v) => ({
          from: typeof v.from === 'string' ? v.from : undefined,
          to: typeof v.to === 'string' ? v.to : undefined,
        })),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);

          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [company] = await tx
            .select({ id: companies.id, timezone: companies.timezone })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          const { from: fromRaw, to: toRaw } = c.req.valid('query');
          const win = parseReportWindow(fromRaw, toRaw, company.timezone);
          if ('error' in win) return c.json({ error: win.error }, 400);
          const { from, to } = win;

          // Issue date is a bare calendar date, so the window compares as dates
          // — no timezone conversion needed, unlike the journal-driven reports
          // which key off a timestamptz.
          const windowInvoices = await tx
            .select({
              invoiceId: invoices.id,
              jobId: invoices.jobId,
              number: invoices.number,
              issueDate: invoices.issueDate,
              status: invoices.status,
              subtotal: invoices.subtotal,
              customerName: contacts.name,
            })
            .from(invoices)
            .innerJoin(contacts, eq(contacts.id, invoices.contactId))
            .where(
              and(
                eq(invoices.accountId, accountId),
                eq(invoices.companyId, id),
                // Allowlist, not a pair of ne()s. The previous form excluded
                // 'void', but the stored value is 'voided' (INVOICE_TRANSITIONS
                // in routes/invoices.ts), so voided invoices counted their full
                // subtotal as billed and overstated that job's margin. An
                // allowlist also can't be silently widened by a new status, and
                // it matches every other report here.
                inArray(invoices.status, ['sent', 'paid']),
                gte(invoices.issueDate, from),
                lte(invoices.issueDate, to),
              ),
            )
            .orderBy(asc(invoices.issueDate), asc(invoices.number));

          // Jobs whose only invoice in this window is still a DRAFT (TMC-203).
          //
          // The window above is built from sent/paid invoices, which is right for
          // revenue — but it also decided which JOBS appear at all, so a job
          // carrying nothing but a draft dropped out of the report entirely. Its
          // costs went with it: not in `jobCosts`, not in `shared`, not in
          // `unattributed` (they are allocated, just to an absent job). Money
          // spent was reported nowhere, which is the TMC-202 failure again a
          // layer up.
          //
          // Deliberately NOT folded into windowInvoices — that list also feeds
          // `unjobbedInvoices`, where a draft would count its own subtotal as
          // billed and recognise revenue on an unsent invoice.
          const draftJobRows = await tx
            .select({ jobId: invoices.jobId })
            .from(invoices)
            .where(
              and(
                eq(invoices.accountId, accountId),
                eq(invoices.companyId, id),
                isNotNull(invoices.jobId),
                inArray(invoices.status, ['draft']),
                gte(invoices.issueDate, from),
                lte(invoices.issueDate, to),
              ),
            );

          // Which invoices belong to a named job. Every invoice in the company,
          // not just the windowed ones: a cost can be tagged to an invoice that
          // sits outside the window and still belongs to a job inside it.
          const invoiceJobRows = await tx
            .select({ id: invoices.id, jobId: invoices.jobId })
            .from(invoices)
            .where(and(eq(invoices.accountId, accountId), eq(invoices.companyId, id)));
          const jobOfInvoice = new Map(invoiceJobRows.map((r) => [r.id, r.jobId]));

          const costRows = await tx
            .select({
              invoiceId: expenseAllocations.invoiceId,
              jobId: expenseAllocations.jobId,
              amount: expenses.amount,
              share: expenseAllocations.share,
            })
            .from(expenseAllocations)
            .innerJoin(expenses, eq(expenses.id, expenseAllocations.expenseId))
            .where(
              and(
                eq(expenseAllocations.accountId, accountId),
                eq(expenseAllocations.companyId, id),
                isNull(expenses.deletedAt),
              ),
            );

          // Three buckets, and every allocation row lands in exactly one of
          // them, so the totals below still reconcile against the P&L.
          const costByInvoice = new Map<string, number>();
          const costByJob = new Map<string, number>();
          let sharedCents = 0;
          const addTo = (map: Map<string, number>, key: string, cents: number) =>
            map.set(key, (map.get(key) ?? 0) + cents);
          for (const row of costRows) {
            const cents = Math.round(Number(row.amount) * 100 * Number(row.share));
            if (row.jobId) {
              addTo(costByJob, row.jobId, cents);
              continue;
            }
            if (row.invoiceId) {
              // A cost tagged at invoice grain rolls up to that invoice's job if
              // it has one. This is what keeps a job honest for costs tagged
              // before the job existed, and for the invoice-grain tagging the
              // expense screens still do.
              const ownerJob = jobOfInvoice.get(row.invoiceId) ?? null;
              if (ownerJob) addTo(costByJob, ownerJob, cents);
              else addTo(costByInvoice, row.invoiceId, cents);
              continue;
            }
            sharedCents += cents;
          }

          // Invoices that never joined a job keep behaving exactly as they did
          // before jobs existed: the invoice IS the job. For a company with no
          // jobs at all, this list and the totals are unchanged.
          const unjobbedInvoices = windowInvoices
            .filter((inv) => !inv.jobId)
            .map((inv) => {
              const costCents = costByInvoice.get(inv.invoiceId) ?? 0;
              const billedCents = Math.round(Number(inv.subtotal) * 100);
              return {
                invoiceId: inv.invoiceId,
                number: inv.number,
                issueDate: inv.issueDate,
                status: inv.status,
                customerName: inv.customerName,
                billed: inv.subtotal,
                costs: centsToMoney(costCents),
                made: centsToMoney(billedCents - costCents),
              };
            });

          // A job qualifies for the window when at least one of its invoices was
          // issued inside it. Its billed figure then covers ALL its invoices, not
          // just the windowed ones — the job is the unit here, not the month, and
          // its costs were never window-scoped either. Halving a deposit-plus-
          // final job at the window edge would show a loss that isn't real.
          //
          // Drafted-only jobs join them (TMC-203). A job with an invoice written
          // but not sent is work in progress, not work that did not happen, and
          // leaving it out took its costs off the report with it.
          const windowJobIds = [
            ...new Set(
              [...windowInvoices, ...draftJobRows]
                .map((inv) => inv.jobId)
                .filter((v): v is string => !!v),
            ),
          ];
          const [jobRows, billedByJob, minutesByJob, unbilledByJob, draftedByJob] =
            await Promise.all([
              windowJobIds.length > 0
                ? tx
                    .select({
                      id: jobsTable.id,
                      name: jobsTable.name,
                      status: jobsTable.status,
                      customerName: contacts.name,
                    })
                    .from(jobsTable)
                    .leftJoin(contacts, eq(contacts.id, jobsTable.contactId))
                    .where(
                      and(eq(jobsTable.accountId, accountId), inArray(jobsTable.id, windowJobIds)),
                    )
                    .orderBy(asc(jobsTable.name))
                : Promise.resolve([]),
              jobBilledCents(tx, accountId, id, windowJobIds),
              jobMinutes(tx, accountId, id, windowJobIds),
              jobUnbilled(tx, accountId, id, windowJobIds),
              jobDraftedCents(tx, accountId, id, windowJobIds),
            ]);

          const namedJobs = jobRows.map((job) => {
            const billedCents = billedByJob.get(job.id) ?? 0;
            const costCents = costByJob.get(job.id) ?? 0;
            const draftedCents = draftedByJob.get(job.id) ?? 0;
            const madeCents = billedCents - costCents;
            const minutes = minutesByJob.get(job.id) ?? 0;
            return {
              jobId: job.id,
              name: job.name,
              status: job.status,
              customerName: job.customerName,
              billed: centsToMoney(billedCents),
              // Written but not sent. Reported beside `billed`, never inside it
              // — the ledger recognises revenue on the issue date, and a draft
              // has not been issued (TMC-202/203).
              drafted: centsToMoney(draftedCents),
              costs: centsToMoney(costCents),
              made: jobMade(billedCents, costCents),
              minutes,
              hours: displayHours(minutes),
              // Tracked hours no invoice has claimed. Not part of billed or
              // made — this is work done and not yet charged for, which is a
              // different question from what the job has earned.
              readyToBill: centsToMoney(unbilledByJob.get(job.id)?.cents ?? 0),
              unratedMinutes: unbilledByJob.get(job.id)?.unratedMinutes ?? 0,
              // What an hour on this job actually paid. The number time tracking
              // exists to produce, and null rather than 0 when no hours are
              // tracked — 0 would read as "this job paid nothing an hour".
              effectiveHourly: effectiveHourly(madeCents, minutes, billedCents),
            };
          });

          // Costs the user never answered for. Counted in the window by expense
          // date rather than by job, since they belong to no job by definition.
          const [unattributed] = await tx
            .select({
              total: sql<string>`coalesce(sum(${expenses.amount}), 0)::numeric(15,2)`,
            })
            .from(expenses)
            .where(
              and(
                eq(expenses.accountId, accountId),
                eq(expenses.companyId, id),
                isNull(expenses.deletedAt),
                gte(expenses.expenseDate, from),
                lte(expenses.expenseDate, to),
                sql`not exists (select 1 from ${expenseAllocations} where ${expenseAllocations.expenseId} = ${expenses.id})`,
              ),
            );

          // Totals span both lists — a named job and a bare invoice are both
          // "a job" as far as the bottom line is concerned.
          const allRows = [...namedJobs, ...unjobbedInvoices];
          const billedTotalCents = allRows.reduce((t, r) => t + toCents(r.billed), 0);
          const jobCostTotalCents = allRows.reduce((t, r) => t + toCents(r.costs), 0);
          const trackedMinutes = namedJobs.reduce((t, r) => t + r.minutes, 0);
          const readyTotalCents = namedJobs.reduce((t, r) => t + toCents(r.readyToBill), 0);
          const draftedTotalCents = namedJobs.reduce((t, r) => t + toCents(r.drafted), 0);
          // Costs on jobs with no recognised revenue — the rows whose `made` is
          // null. They are work in progress, so they must not be subtracted from
          // the bottom line either: the same matching argument that keeps them
          // out of a row's margin keeps them out of the total (TMC-203).
          //
          // Reported rather than silently dropped, so `jobCosts` still equals
          // what the rows show and the two figures can be reconciled:
          //   made = billed − (jobCosts − workInProgress) − shared
          const wipCostCents = allRows.reduce(
            (t, r) => t + (r.made === null ? toCents(r.costs) : 0),
            0,
          );

          return c.json({
            from,
            to,
            jobs: namedJobs,
            // Invoices with no job, each standing in as its own job — the exact
            // rows and numbers this report returned before jobs existed.
            unjobbedInvoices,
            totals: {
              billed: centsToMoney(billedTotalCents),
              // Written but not sent, across the jobs in this window.
              drafted: centsToMoney(draftedTotalCents),
              jobCosts: centsToMoney(jobCostTotalCents),
              // The slice of jobCosts sitting on jobs that have recognised no
              // revenue yet. Held out of `made` below; see the reconciliation.
              workInProgress: centsToMoney(wipCostCents),
              shared: centsToMoney(sharedCents),
              unattributed: unattributed?.total ?? '0.00',
              // Jobs minus their own costs minus the shared pool. Deliberately
              // excludes unattributed — those are costs the user hasn't placed,
              // and folding them in silently would make this disagree with the
              // per-job rows above it.
              //
              // Work-in-progress costs come out too (TMC-203), so the bottom
              // line never charges the period for work whose revenue has not
              // landed. Without this the total contradicted its own rows: every
              // WIP row showed "—" for margin while the total quietly subtracted
              // that row's costs anyway.
              made: centsToMoney(
                billedTotalCents - (jobCostTotalCents - wipCostCents) - sharedCents,
              ),
              minutes: trackedMinutes,
              hours: displayHours(trackedMinutes),
              // Deliberately outside `made`: this is work not yet charged for,
              // not profit. Folding it in would inflate the bottom line with
              // money nobody has been invoiced for.
              readyToBill: centsToMoney(readyTotalCents),
            },
          });
        },
      )
  );
}

export type ReportsAppType = ReturnType<typeof reportsRoutes>;
