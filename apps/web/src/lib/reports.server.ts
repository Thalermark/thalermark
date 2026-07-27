import { pickActiveCompany } from '$lib/active-company';
import { apiBaseUrl, serverApiClient, serverApiHeaders } from '$lib/api.server';
import { error } from '@sveltejs/kit';

// Shared loaders for the report pages. They all read a from/to window (default
// YTD) off a single company (single-company MVP picks the first), surface the
// preset quick-links, and highlight the active preset from the server-echoed
// from/to. Each report has its own endpoint + shape; the window plumbing here
// is the common part.

export type Preset = { key: string; label: string; from: string; to: string };

const ymd = (d: Date) => d.toISOString().slice(0, 10);

// Standard reporting windows computed from `now` (UTC).
export function periodPresets(now = new Date()): Preset[] {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const today = ymd(now);
  const qStart = Math.floor(m / 3) * 3;
  return [
    { key: 'month', label: 'This month', from: ymd(new Date(Date.UTC(y, m, 1))), to: today },
    {
      key: 'quarter',
      label: 'This quarter',
      from: ymd(new Date(Date.UTC(y, qStart, 1))),
      to: today,
    },
    { key: 'ytd', label: 'Year to date', from: ymd(new Date(Date.UTC(y, 0, 1))), to: today },
    {
      key: 'lastyear',
      label: 'Last year',
      from: ymd(new Date(Date.UTC(y - 1, 0, 1))),
      to: ymd(new Date(Date.UTC(y - 1, 11, 31))),
    },
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
  return { client, companyId: company.id };
}

// Company + window + presets shared by every report loader.
async function reportContext(event: Parameters<typeof serverApiClient>[0]) {
  const { client, companyId } = await reportCompany(event);

  const presets = periodPresets();
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
function fillMonths(from: string, to: string, months: { month: string; revenue: string }[]) {
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
// (default today) instead of a window — no presets, just a date input.
async function reportContextAsOf(event: Parameters<typeof serverApiClient>[0]) {
  const client = serverApiClient(event);
  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');
  const asOf = event.url.searchParams.get('asOf') || ymd(new Date());
  return { client, companyId: company.id, asOf };
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

// --- Schedule C worksheet -------------------------------------------------
// Unlike the other reports this is scoped to a calendar tax year, not a
// from/to window, and carries an accounting basis. Both ride the query string
// so a bookmarked link reproduces exactly what the user was looking at.

export type ScheduleCLineRow = {
  line: string;
  label: string;
  amount: string;
  userSupplied?: true;
  accounts: { code: string; name: string; amount: string }[];
};

export type ScheduleC = {
  year: number;
  basis: 'cash' | 'accrual';
  companyAccountingMethod: string;
  from: string;
  to: string;
  partI: {
    grossReceipts: string;
    returnsAndAllowances: string;
    netReceipts: string;
    costOfGoodsSold: string;
    grossProfit: string;
    otherIncome: string;
    grossIncome: string;
  };
  partII: ScheduleCLineRow[];
  unmappedExpenses: { code: string; name: string; amount: string }[];
  totalExpenses: string;
  tentativeProfit: string;
  homeOffice: null;
  netProfit: string;
};

// The tax years worth offering: the current one (an in-progress preview) plus
// three back, which covers the normal amended-return window without turning
// the picker into a scrolling list.
export function taxYearOptions(now = new Date()): number[] {
  const y = now.getUTCFullYear();
  return [y, y - 1, y - 2, y - 3];
}

export async function loadScheduleC(event: Parameters<typeof serverApiClient>[0]) {
  const { client, companyId } = await reportCompany(event);
  const sp = event.url.searchParams;

  const years = taxYearOptions();
  const yearParam = Number(sp.get('year'));
  // Fall back to the current year on anything unparseable rather than 400ing —
  // a hand-edited URL should land somewhere sensible, and the API bounds it too.
  const year =
    Number.isInteger(yearParam) && yearParam > 1900 ? yearParam : new Date().getUTCFullYear();

  // Omitted basis means "use the company's stored election", which the API
  // resolves — don't guess it here or the page and the setting can disagree.
  const basisParam = sp.get('basis');
  const basis = basisParam === 'cash' || basisParam === 'accrual' ? basisParam : undefined;

  const res = await client.api.companies[':id']['schedule-c'].$get({
    param: { id: companyId },
    query: { year, ...(basis ? { basis } : {}) },
  });
  // 409 = this business doesn't file a Schedule C (partnership / S-corp / C-corp
  // — see TMC-124). The hub already hides the card, so this only catches a typed
  // or bookmarked URL; say which form they file rather than "failed to load".
  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as { taxForm?: string } | null;
    throw error(
      404,
      `Schedule C isn't your form — your business files ${body?.taxForm ?? 'a different return'}.`,
    );
  }
  if (!res.ok) throw error(res.status, 'failed to load the Schedule C worksheet');
  const report = (await res.json()) as ScheduleC;
  return { report, years };
}
