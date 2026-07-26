// Shared helpers for the mobile report screens, ported from web's
// reports.server.ts: the standard reporting windows, the active-preset match,
// the month-gap fill for the revenue trend, and the money formatter.

export type Preset = { key: string; label: string; from: string; to: string };

const ymd = (d: Date) => d.toISOString().slice(0, 10);

// Standard reporting windows computed from `now` (UTC) — matches web exactly so
// the same ?from=&to= resolve identically on both clients.
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

export function activePresetKey(presets: Preset[], from: string, to: string): string | null {
  return presets.find((p) => p.from === from && p.to === to)?.key ?? null;
}

// YTD is the default window for every window report; today is the default asOf
// for the point-in-time ones — same defaults web's loaders apply.
export function ytdWindow(): { from: string; to: string } {
  const p = periodPresets().find((x) => x.key === 'ytd');
  return { from: p?.from ?? '', to: p?.to ?? '' };
}

export const todayYmd = () => ymd(new Date());

export const fmt = (s: string) =>
  Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// Fill the gaps between from..to so the revenue trend is a continuous month
// series (the API only returns months that had sales). Months are 'YYYY-MM'.
export function fillMonths(
  from: string,
  to: string,
  months: { month: string; revenue: string }[],
): { month: string; revenue: string }[] {
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

// Tax years offered by the Schedule C worksheet — the current one (an
// in-progress preview) plus three back, which covers the normal amended-return
// window without turning a phone-sized picker into a scroll. Mirrors web's
// taxYearOptions in reports.server.ts.
export function taxYearOptions(now = new Date()): number[] {
  const y = now.getUTCFullYear();
  return [y, y - 1, y - 2, y - 3];
}
