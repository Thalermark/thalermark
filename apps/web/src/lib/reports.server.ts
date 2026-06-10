import { serverApiClient } from '$lib/api.server';
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

// Company + window + presets shared by every report loader.
async function reportContext(event: Parameters<typeof serverApiClient>[0]) {
  const client = serverApiClient(event);
  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = companies[0];
  if (!company) throw error(500, 'no company on this account');

  const presets = periodPresets();
  const ytd = presets.find((p) => p.key === 'ytd');
  const sp = event.url.searchParams;
  const from = sp.get('from') || ytd?.from || '';
  const to = sp.get('to') || ytd?.to || '';
  return { client, companyId: company.id, from, to, presets };
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
  customers: { customerId: string; name: string | null; sales: string; invoiceCount: number }[];
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
