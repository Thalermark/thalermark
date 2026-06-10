import { serverApiClient } from '$lib/api.server';
import { error } from '@sveltejs/kit';

// Shared loader for the Profit & Loss and Expenses-by-category report pages —
// both read the same /profit-loss endpoint (expenses are its expense section),
// just rendered differently. Single-company MVP auto-picks the first company.

export type Preset = { key: string; label: string; from: string; to: string };

const ymd = (d: Date) => d.toISOString().slice(0, 10);

// Standard reporting windows computed from `now` (UTC). Surfaced as quick links
// on the report pages; the loader maps the active ?from=&to= back to a key so
// the matching button highlights.
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

export type ProfitLoss = {
  from: string;
  to: string;
  revenue: { code: string; name: string; taxMapping: string | null; amount: string }[];
  expenses: { code: string; name: string; taxMapping: string | null; amount: string }[];
  totalRevenue: string;
  totalExpenses: string;
  netProfit: string;
};

export async function loadProfitLoss(event: Parameters<typeof serverApiClient>[0]): Promise<{
  report: ProfitLoss;
  presets: Preset[];
  activeKey: string | null;
}> {
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

  const res = await client.api.companies[':id']['profit-loss'].$get({
    param: { id: company.id },
    query: { from, to },
  });
  if (!res.ok) throw error(res.status, 'failed to load report');
  const report = (await res.json()) as ProfitLoss;

  // Highlight the matching preset (server-echoed from/to so it's exact).
  const activeKey = presets.find((p) => p.from === report.from && p.to === report.to)?.key ?? null;
  return { report, presets, activeKey };
}
