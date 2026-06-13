<script lang="ts">
  import ExportCsvButton from '$lib/components/ExportCsvButton.svelte';
  import PeriodSelector from '$lib/components/PeriodSelector.svelte';
  import type { CsvCell } from '$lib/csv';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const { report, presets, activeKey } = $derived(data);

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const csvRows = $derived<CsvCell[][]>([
    ['Month', 'Collected'],
    ...report.months.map((m) => [m.month, m.collected] as CsvCell[]),
    ['Total', report.total],
  ]);
</script>

<div class="flex flex-wrap items-baseline justify-between gap-6">
  <div>
    <a href="/reports" class="eyebrow text-fg/60 hover:text-fg">← Reports</a>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      Sales tax collected<span class="text-accent">.</span>
    </h1>
  </div>
  <ExportCsvButton
    filename="sales-tax_{report.from}_{report.to}"
    rows={csvRows}
    disabled={report.months.length === 0}
  />
</div>

<PeriodSelector {presets} {activeKey} from={report.from} to={report.to} />

<p class="mt-4 text-sm text-fg/60">
  {report.from} → {report.to}. Sales tax billed on your invoices, net of voids — what you've
  collected to remit. Awareness, not tax advice.
</p>

<div class="mt-8 rounded-sm border border-fg/10 bg-surface-2 p-5">
  <div class="label">Total collected</div>
  <div class="mt-2 font-serif text-4xl font-light text-fg">{fmt(report.total)}</div>
</div>

{#if report.months.length > 0}
  <div class="mt-4 overflow-hidden rounded-sm border border-fg/10 bg-surface-2">
    <table class="w-full text-left text-sm">
      <thead class="bg-surface">
        <tr class="label">
          <th class="px-5 py-3">Month</th>
          <th class="px-5 py-3 text-right">Collected</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-fg/10">
        {#each report.months as m (m.month)}
          <tr>
            <td class="px-5 py-3 font-mono tabular-nums text-fg/80">{m.month}</td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">{fmt(m.collected)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
