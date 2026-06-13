<script lang="ts">
  import ExportCsvButton from '$lib/components/ExportCsvButton.svelte';
  import PeriodSelector from '$lib/components/PeriodSelector.svelte';
  import type { CsvCell } from '$lib/csv';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const { report, series, presets, activeKey } = $derived(data);

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const shortMonth = (key: string) => {
    const [, m] = key.split('-').map(Number);
    return MONTHS[(m ?? 1) - 1];
  };

  const max = $derived(Math.max(0, ...series.map((m) => Number(m.revenue))));
  const pct = (v: string) => (max > 0 ? (Number(v) / max) * 100 : 0);
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
    <a href="/reports" class="eyebrow text-ink/60 hover:text-ink">← Reports</a>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-ink">
      Revenue over time<span class="text-gold-deep">.</span>
    </h1>
  </div>
  <ExportCsvButton filename="revenue-over-time_{report.from}_{report.to}" rows={csvRows} />
</div>

<PeriodSelector {presets} {activeKey} from={report.from} to={report.to} />

<p class="mt-4 text-sm text-ink/60">
  {report.from} → {report.to}. Pre-tax sales from sent or paid invoices, by the month they were
  issued.
</p>

{#if !hasRevenue}
  <p class="mt-8 text-ink/70">No revenue in this period.</p>
{:else}
  <div class="mt-8 rounded-sm border border-ink/10 bg-cream-warm p-5">
    <div class="flex h-56 items-end gap-1.5 overflow-x-auto">
      {#each series as m (m.month)}
        <div
          class="flex h-full min-w-6 flex-1 flex-col justify-end"
          title="{m.month}: {fmt(m.revenue)}"
        >
          <div class="w-full rounded-t-sm bg-gold-deep transition-all" style="height: {pct(m.revenue)}%"></div>
        </div>
      {/each}
    </div>
    <div class="mt-2 flex gap-1.5 overflow-x-auto">
      {#each series as m (m.month)}
        <div class="min-w-6 flex-1 text-center font-mono text-[10px] uppercase tracking-wide text-ink/50">
          {shortMonth(m.month)}
        </div>
      {/each}
    </div>
    <div class="mt-5 flex items-baseline justify-between border-t border-ink/10 pt-4 font-mono text-xs uppercase tracking-widest text-ink/60">
      <span>Total</span>
      <span class="text-base tabular-nums text-ink">{fmt(report.total)}</span>
    </div>
  </div>
{/if}
