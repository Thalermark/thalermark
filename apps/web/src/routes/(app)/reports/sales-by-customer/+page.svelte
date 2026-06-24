<script lang="ts">
  import ExportCsvButton from '$lib/components/ExportCsvButton.svelte';
  import PeriodSelector from '$lib/components/PeriodSelector.svelte';
  import type { CsvCell } from '$lib/csv';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const { report, presets, activeKey } = $derived(data);

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const total = $derived(Number(report.totalSales));
  const rows = $derived(
    report.contacts.map((c) => ({
      ...c,
      share: total > 0 ? (Number(c.sales) / total) * 100 : 0,
    })),
  );

  const csvRows = $derived<CsvCell[][]>([
    ['Contact', 'Invoices', 'Sales', 'Share %'],
    ...rows.map(
      (c) => [c.name ?? '', c.invoiceCount, c.sales, c.share.toFixed(1)] as CsvCell[],
    ),
    ['Total', '', report.totalSales, ''],
  ]);
</script>

<div class="flex flex-wrap items-baseline justify-between gap-6">
  <div>
    <a href="/reports" class="eyebrow text-fg/60 hover:text-fg">← Reports</a>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      Sales by contact<span class="text-accent">.</span>
    </h1>
  </div>
  <ExportCsvButton
    filename="sales-by-customer_{report.from}_{report.to}"
    rows={csvRows}
    disabled={rows.length === 0}
  />
</div>

<PeriodSelector {presets} {activeKey} from={report.from} to={report.to} />

<p class="mt-4 text-sm text-fg/60">
  {report.from} → {report.to}. Pre-tax sales from sent or paid invoices, top 25 contacts by
  revenue.
</p>

{#if rows.length === 0}
  <p class="mt-8 text-fg/70">No sales in this period.</p>
{:else}
  <div class="mt-8 overflow-hidden rounded-sm border border-fg/10 bg-surface-2">
    <table class="w-full text-left text-sm">
      <thead class="bg-surface">
        <tr class="label">
          <th class="px-5 py-3">Contact</th>
          <th class="w-1/3 px-5 py-3">Share</th>
          <th class="w-20 px-5 py-3 text-right">Invoices</th>
          <th class="w-36 px-5 py-3 text-right">Sales</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-fg/10">
        {#each rows as c (c.contactId)}
          <tr>
            <td class="px-5 py-3">
              <a href="/contacts/{c.contactId}" class="text-fg hover:text-accent">
                {c.name ?? '—'}
              </a>
            </td>
            <td class="px-5 py-3">
              <div class="flex items-center gap-2">
                <div class="h-2 flex-1 overflow-hidden rounded-full bg-fg/10">
                  <div class="h-full rounded-full bg-accent" style="width: {c.share}%"></div>
                </div>
                <span class="w-10 text-right font-mono text-xs tabular-nums text-fg/50">
                  {c.share.toFixed(0)}%
                </span>
              </div>
            </td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-fg/70">{c.invoiceCount}</td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">{fmt(c.sales)}</td>
          </tr>
        {/each}
      </tbody>
      <tfoot class="border-t border-fg/10 bg-surface">
        <tr class="font-mono text-xs uppercase tracking-widest">
          <td class="px-5 py-3 text-fg/70">Total</td>
          <td></td>
          <td></td>
          <td class="px-5 py-3 text-right text-base tabular-nums text-fg">
            {fmt(report.totalSales)}
          </td>
        </tr>
      </tfoot>
    </table>
  </div>
{/if}
