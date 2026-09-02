import { pickActiveCompany } from '$lib/active-company';
import { apiBaseUrl, serverApiClient, serverApiHeaders } from '$lib/api.server';
import { error } from '@sveltejs/kit';
import { localToday } from '@thalermark/validation';

// Shared loaders for the report pages. They all read a from/to window (default
// YTD) off a single company (single-company MVP picks the first), surface the
// preset quick-links, and highlight the active preset from the server-echoed
// from/to. Each report has its own endpoint + shape; the window plumbing here
// is the common part.

export type Preset = { key: string; label: string; from: string; to: string };

// Standard reporting windows anchored to `today`, the company's own calendar
// day, never this server's clock. The web server runs UTC, so an evening
// visit computed every default a day ahead, and on New Year's Eve the default
// YTD window became the empty new year (TMC-302).
export function periodPresets(today: string): Preset[] {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const mm = (n: number) => String(n).padStart(2, '0');
  const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
  return [
    { key: 'month', label: 'This month', from: `${y}-${mm(m)}-01`, to: today },
    { key: 'quarter', label: 'This quarter', from: `${y}-${mm(qStartMonth)}-01`, to: today },
    { key: 'ytd', label: 'Year to date', from: `${y}-01-01`, to: today },
    { key: 'lastyear', label: 'Last year', from: `${y - 1}-01-01`, to: `${y - 1}-12-31` },
  ];
}

function activePresetKey(presets: Preset[], from: string, to: string): string | null {
  return presets.find((p) => p.from === from && p.to === to)?.key ?? null;
}

// The active company, which every report is scoped to. Split out of
// reportContext because the Schedule C worksheet picks a tax *year* rather than
// a from/to window and so shares the company lookup but none of the presets.
async function reportCompany(event: Parameters<typeof serverApiClient>[0]) {
  const client = serverApiClient(event);
  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');
  return { client, companyId: company.id, timezone: company.timezone };
}

// Company + window + presets shared by every report loader.
async function reportContext(event: Parameters<typeof serverApiClient>[0]) {
  const { client, companyId, timezone } = await reportCompany(event);

  const presets = periodPresets(localToday(timezone));
  const ytd = presets.find((p) => p.key === 'ytd');
  const sp = event.url.searchParams;
  const from = sp.get('from') || ytd?.from || '';
  const to = sp.get('to') || ytd?.to || '';
  return { client, companyId, from, to, presets };
}

export type ProfitLoss = {
  from: string;
  to: string;
  revenue: { code: string; name: string; taxMapping: string | null; amount: string }[];
  expenses: { code: string; name: string; taxMapping: string | null; amount: string }[];
  totalRevenue: string;
  totalExpenses: string;
  netProfit: string;
};

export async function loadProfitLoss(event: Parameters<typeof serverApiClient>[0]) {
  const { client, companyId, from, to, presets } = await reportContext(event);
  const res = await client.api.companies[':id']['profit-loss'].$get({
    param: { id: companyId },
    query: { from, to },
  });
  if (!res.ok) throw error(res.status, 'failed to load report');
  const report = (await res.json()) as ProfitLoss;
  return { report, presets, activeKey: activePresetKey(presets, report.from, report.to) };
}

export type SalesByCustomer = {
  from: string;
  to: string;
  contacts: { contactId: string; name: string | null; sales: string; invoiceCount: number }[];
  totalSales: string;
};

export async function loadSalesByCustomer(event: Parameters<typeof serverApiClient>[0]) {
  const { client, companyId, from, to, presets } = await reportContext(event);
  const res = await client.api.companies[':id']['sales-by-customer'].$get({
    param: { id: companyId },
    query: { from, to },
  });
  if (!res.ok) throw error(res.status, 'failed to load report');
  const report = (await res.json()) as SalesByCustomer;
  return { report, presets, activeKey: activePresetKey(presets, report.from, report.to) };
}

export type RevenueOverTime = {
  from: string;
  to: string;
  months: { month: string; revenue: string }[];
  total: string;
};

// Fill the gaps between from..to so the trend is a continuous month series
// (the API only returns months that had sales). Months are 'YYYY-MM'.
export function fillMonths(from: string, to: string, months: { month: string; revenue: string }[]) {
  const byMonth = new Map(months.map((m) => [m.month, m.revenue]));
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  const series: { month: string; revenue: string }[] = [];
  let y = fy as number;
  let m = fm as number;
  // Cap at 120 months as a safety stop for an absurd range.
  for (let i = 0; i < 120 && (y < (ty as number) || (y === ty && m <= (tm as number))); i++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    series.push({ month: key, revenue: byMonth.get(key) ?? '0.00' });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return series;
}

export async function loadRevenueOverTime(event: Parameters<typeof serverApiClient>[0]) {
  const { client, companyId, from, to, presets } = await reportContext(event);
  const res = await client.api.companies[':id']['revenue-over-time'].$get({
    param: { id: companyId },
    query: { from, to },
  });
  if (!res.ok) throw error(res.status, 'failed to load report');
  const report = (await res.json()) as RevenueOverTime;
  const series = fillMonths(report.from, report.to, report.months);
  return { report, series, presets, activeKey: activePresetKey(presets, report.from, report.to) };
}

export type EstimateWinRate = {
  from: string;
  to: string;
  byStatus: { status: string; count: number; value: string }[];
  acceptedCount: number;
  declinedCount: number;
  // Quotes that ran out without a reply. Counted, but NOT part of decidedCount
  // — the customer said nothing, and the expiry date was the operator's own
  // choice (TMC-255).
  lapsedCount: number;
  // How many answers the rate is computed over: accepted + declined.
  decidedCount: number;
  winRate: string | null;
};

export async function loadEstimateWinRate(event: Parameters<typeof serverApiClient>[0]) {
  const { client, companyId, from, to, presets } = await reportContext(event);
  const res = await client.api.companies[':id']['estimate-win-rate'].$get({
    param: { id: companyId },
    query: { from, to },
  });
  if (!res.ok) throw error(res.status, 'failed to load report');
  const report = (await res.json()) as EstimateWinRate;
  return { report, presets, activeKey: activePresetKey(presets, report.from, report.to) };
}

// Point-in-time reports (balance sheet, A/R aging) take a single ?asOf= date
// (default today) instead of a window: no presets, just a date input. The
// default is today in the COMPANY's timezone, same helper the API uses, so
// the two can't disagree (TMC-302: this server's UTC clock ran evening
// reports a day ahead).
async function reportContextAsOf(event: Parameters<typeof serverApiClient>[0]) {
  const { client, companyId, timezone } = await reportCompany(event);
  const asOf = event.url.searchParams.get('asOf') || localToday(timezone);
  return { client, companyId, asOf };
}

export type BalanceSheet = {
  asOf: string;
  assets: { code: string; name: string; amount: string }[];
  liabilities: { code: string; name: string; amount: string }[];
  equity: { code: string; name: string; amount: string }[];
  netIncome: string;
  totalAssets: string;
  totalLiabilities: string;
  totalEquity: string;
  totalLiabilitiesAndEquity: string;
  balanced: boolean;
};

export async function loadBalanceSheet(event: Parameters<typeof serverApiClient>[0]) {
  const { client, companyId, asOf } = await reportContextAsOf(event);
  const res = await client.api.companies[':id']['balance-sheet'].$get({
    param: { id: companyId },
    query: { asOf },
  });
  if (!res.ok) throw error(res.status, 'failed to load report');
  return { report: (await res.json()) as BalanceSheet };
}

export type ArAging = {
  asOf: string;
  buckets: { key: string; label: string; count: number; amount: string }[];
  invoices: {
    id: string;
    number: string;
    customerName: string | null;
    dueDate: string;
    daysPastDue: number;
    amount: string;
  }[];
  total: string;
};

export async function loadArAging(event: Parameters<typeof serverApiClient>[0]) {
  const { client, companyId, asOf } = await reportContextAsOf(event);
  const res = await client.api.companies[':id']['ar-aging'].$get({
    param: { id: companyId },
    query: { asOf },
  });
  if (!res.ok) throw error(res.status, 'failed to load report');
  return { report: (await res.json()) as ArAging };
}

export type SalesTax = {
  from: string;
  to: string;
  months: { month: string; collected: string }[];
  total: string;
};

export async function loadSalesTax(event: Parameters<typeof serverApiClient>[0]) {
  const { client, companyId, from, to, presets } = await reportContext(event);
  const res = await client.api.companies[':id']['sales-tax'].$get({
    param: { id: companyId },
    query: { from, to },
  });
  if (!res.ok) throw error(res.status, 'failed to load report');
  const report = (await res.json()) as SalesTax;
  return { report, presets, activeKey: activePresetKey(presets, report.from, report.to) };
}

// General ledger — every journal entry over a window, joined with the chart of
// accounts, plus a per-account trial-balance summary. The hidden double-entry
// surfaced for the people who need it: this loader (and its page) only resolves
// for roles with reports:export, since the export endpoint 403s everyone else.
export type GeneralLedger = {
  companyId: string;
  companyName: string;
  from: string | null;
  to: string | null;
  entries: {
    id: string;
    postedAt: string;
    sourceEntityType: string;
    sourceEntityId: string;
    memo: string | null;
    lines: {
      code: string;
      accountName: string;
      accountType: string;
      side: 'debit' | 'credit';
      amount: string;
    }[];
  }[];
  trialBalance: {
    code: string;
    accountName: string;
    accountType: string;
    debit: string;
    credit: string;
    net: string;
  }[];
};

export async function loadGeneralLedger(event: Parameters<typeof serverApiClient>[0]) {
  const { companyId, from, to, presets } = await reportContext(event);
  // The ledger export reads its query params manually (no validator), so the
  // typed hc client doesn't surface a `query` for it — go through the raw-fetch
  // escape hatch (apiBaseUrl + serverApiHeaders) instead.
  const qs = new URLSearchParams({ from, to }).toString();
  const res = await event.fetch(`${apiBaseUrl()}/api/companies/${companyId}/ledger/export?${qs}`, {
    headers: serverApiHeaders(event),
  });
  // A non-export role 403s here — let SvelteKit render the error rather than a
  // blank ledger. The hub card is may()-gated so this is the direct-URL path.
  if (!res.ok) throw error(res.status, 'failed to load the general ledger');
  const report = (await res.json()) as GeneralLedger;
  return {
    report,
    presets,
    activeKey: activePresetKey(presets, report.from ?? '', report.to ?? ''),
  };
}

// --- Tax worksheet --------------------------------------------------------
// Unlike the other reports this is scoped to a calendar tax year, not a
// from/to window, and carries an accounting basis. Both ride the query string
// so a bookmarked link reproduces exactly what the user was looking at.
//
// One page, four forms (TMC-162): the API dispatches on the company's business
// type and returns the form it files, so nothing here routes by entity type.

export type TaxLineRow = {
  line: string;
  label: string;
  role: string;
  // Null on a line nothing can fill — rendered as an explicit blank, never
  // 0.00, which would read as "you had none of this".
  amount: string | null;
  accounts: { code: string; name: string; amount: string }[];
  // Non-ledger figures summed into this line's amount — standard mileage, and
  // only on Schedule C line 9 today. Rendered beside the line so both halves of
  // a part-mapped, part-computed figure stay visible.
  computed?: { line: string; label: string; amount: string }[];
  // The catch-all "other deductions" line, whose accounts ARE the itemised
  // statement the return is filed with. Rendered expanded, not behind a
  // disclosure.
  itemized?: true;
  userSupplied?: true;
  // Part of an a/b/c group where only the balance carries into the column that
  // sums to total deductions. Indented so a reader adding up that column
  // doesn't double-count.
  subLine?: true;
};

export type TaxWorksheet = {
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
  // Standard mileage (TMC-179). Present on every form — only the addend onto a
  // line is Schedule-C-only, because a corporation reimburses the driver rather
  // than deducting mileage on its own return.
  mileage: {
    method: 'standard' | 'actual';
    companyMethod: string;
    miles: string;
    amount: string;
    foregone: string;
    unratedMiles: string;
    tripCount: number;
    overlapping: { code: string; name: string; amount: string }[];
  };
  // Schedule C Part IV (TMC-179). A sibling of `mileage`, not deduction rows —
  // it is a date and two yes/nos, not money. `destination` is 'none' on the
  // three corporate/partnership forms, which is an answer: they reimburse the
  // driver rather than disclosing a vehicle of their own.
  vehicleInfo: {
    destination: 'schedule_c_part_iv' | 'form_4562_part_v' | 'none';
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
      writtenEvidence: true;
      missing: ('placed_in_service' | 'personal_use' | 'another_vehicle' | 'total_miles')[];
      inconsistent: boolean;
    }[];
  };
};

// The tax years worth offering: the current one (an in-progress preview) plus
// three back, which covers the normal amended-return window without turning
// the picker into a scrolling list. `currentYear` is the company's, not the
// machine's: on New Year's Eve evening the UTC clock is already next year.
export function taxYearOptions(currentYear: number): number[] {
  return [currentYear, currentYear - 1, currentYear - 2, currentYear - 3];
}

export async function loadTaxWorksheet(event: Parameters<typeof serverApiClient>[0]) {
  const { client, companyId, timezone } = await reportCompany(event);
  const sp = event.url.searchParams;

  const currentYear = Number(localToday(timezone).slice(0, 4));
  const years = taxYearOptions(currentYear);
  const yearParam = Number(sp.get('year'));
  // Fall back to the current year on anything unparseable rather than 400ing —
  // a hand-edited URL should land somewhere sensible, and the API bounds it too.
  const year = Number.isInteger(yearParam) && yearParam > 1900 ? yearParam : currentYear;

  // Omitted basis means "use the company's stored election", which the API
  // resolves — don't guess it here or the page and the setting can disagree.
  const basisParam = sp.get('basis');
  const basis = basisParam === 'cash' || basisParam === 'accrual' ? basisParam : undefined;

  // Same contract as basis: omitted means "use the company's stored vehicle
  // election". The override exists so the two figures can be compared without
  // flipping the saved setting (TMC-179).
  const methodParam = sp.get('method');
  const method = methodParam === 'standard' || methodParam === 'actual' ? methodParam : undefined;

  const res = await client.api.companies[':id']['tax-worksheet'].$get({
    param: { id: companyId },
    query: { year, ...(basis ? { basis } : {}), ...(method ? { method } : {}) },
  });
  if (!res.ok) throw error(res.status, 'failed to load the tax worksheet');
  const report = (await res.json()) as TaxWorksheet;
  return { report, years };
}

export type JobMargin = {
  from: string;
  to: string;
  // Named jobs (TMC-181) — a job may own several invoices, so `billed` covers
  // all of them and there is no single invoice number to show.
  jobs: {
    jobId: string;
    name: string;
    status: string;
    customerName: string | null;
    billed: string;
    // Written but not sent. Beside `billed`, never inside it — the ledger
    // recognises revenue on the issue date and a draft has not been issued.
    drafted: string;
    costs: string;
    // Null when the job has recognised no revenue yet. `billed - costs` with
    // nothing billed is the negative of the costs, which reported a loss the
    // job never took (TMC-203); its costs are work in progress instead.
    made: string | null;
    minutes: number;
    hours: string;
    // Null when no time is tracked; 0 would read as "this job paid nothing".
    effectiveHourly: string | null;
    // Tracked hours no invoice has claimed. Not part of billed or made — work
    // done and not yet charged for is a different question from what was earned.
    readyToBill: string;
    unratedMinutes: number;
  }[];
  // Invoices that never joined a job, each standing in as its own job — the
  // rows this report returned before jobs existed, unchanged.
  unjobbedInvoices: {
    invoiceId: string;
    number: string;
    issueDate: string;
    status: string;
    customerName: string | null;
    billed: string;
    costs: string;
    made: string;
  }[];
  totals: {
    billed: string;
    drafted: string;
    jobCosts: string;
    // The slice of jobCosts sitting on jobs that have recognised no revenue.
    // Held out of `made`, so: made = billed − (jobCosts − workInProgress) − shared.
    workInProgress: string;
    shared: string;
    unattributed: string;
    made: string;
    minutes: number;
    hours: string;
    readyToBill: string;
  };
};

// Job margin — what each job made. The invoice IS the job; rows carry the
// customer's name so the list reads the way the user talks about the work.
export async function loadJobMargin(event: Parameters<typeof serverApiClient>[0]) {
  const { client, companyId, from, to, presets } = await reportContext(event);
  const res = await client.api.companies[':id']['job-margin'].$get({
    param: { id: companyId },
    query: { from, to },
  });
  if (!res.ok) throw error(res.status, 'failed to load report');
  const report = (await res.json()) as JobMargin;
  return { report, presets, activeKey: activePresetKey(presets, report.from, report.to) };
}
