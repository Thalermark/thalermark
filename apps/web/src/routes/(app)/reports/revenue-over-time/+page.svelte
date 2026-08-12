<script lang="ts">
  import { ColumnChart } from '$lib/charts';
  import ExportCsvButton from '$lib/components/ExportCsvButton.svelte';
  import PeriodSelector from '$lib/components/PeriodSelector.svelte';
  import type { CsvCell } from '$lib/csv';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const { report, series, presets, activeKey } = $derived(data);

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // The tick now carries the year whenever the window spans more than one.
  // Before this it was always a bare 'Jan', so a range crossing a year end read
  // "Jan … Dec Jan … Dec" with nothing to tell the two years apart.
  const spansYears = $derived(new Set(series.map((m) => m.month.slice(0, 4))).size > 1);
  const monthTick = (key: string) => {
    const [y, m] = key.split('-').map(Number);
    const name = MONTHS[(m ?? 1) - 1];
    return spansYears ? `${name} ${String(y).slice(2)}` : (name ?? key);
  };

  const hasRevenue = $derived(Number(report.total) > 0);

  // The gap-filled month series (every month in range, zero-filled) — what the
  // chart shows.
  const csvRows = $derived<CsvCell[][]>([
    ['Month', 'Revenue'],
    ...series.map((m) => [m.month, m.revenue] as CsvCell[]),
    ['Total', report.total],
  ]);
</script>

<div class="flex flex-wrap items-baseline justify-between gap-6">
  <div>
    <a href="/reports" class="eyebrow text-fg/60 hover:text-fg">← Reports</a>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      Revenue over time<span class="text-accent">.</span>
    </h1>
  </div>
  <ExportCsvButton filename="revenue-over-time_{report.from}_{report.to}" rows={csvRows} />
</div>

<PeriodSelector {presets} {activeKey} from={report.from} to={report.to} />

<p class="mt-4 text-sm text-fg/60">
  {report.from} → {report.to}. Pre-tax sales from sent or paid invoices, by the month they were
  issued.
</p>

{#if !hasRevenue}
  <p class="mt-8 text-fg/70">No revenue in this period.</p>
{:else}
  <div class="mt-8 rounded-sm border border-fg/10 bg-surface-2 p-5">
    <ColumnChart
      data={series}
      x={{ key: 'month', label: (m) => monthTick(m.month), title: 'Month' }}
      series={[{ key: 'revenue', label: 'Revenue' }]}
      caption="Revenue by month, {report.from} to {report.to}."
      empty="No revenue in this period."
    />
    <div class="mt-5 flex items-baseline justify-between border-t border-fg/10 pt-4 font-mono text-xs uppercase tracking-widest text-fg/60">
      <span>Total</span>
      <span class="text-base tabular-nums text-fg">{fmt(report.total)}</span>
    </div>
  </div>
{/if}
