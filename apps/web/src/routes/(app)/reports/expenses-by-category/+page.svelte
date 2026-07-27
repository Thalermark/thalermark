<script lang="ts">
  import ExportCsvButton from '$lib/components/ExportCsvButton.svelte';
  import PeriodSelector from '$lib/components/PeriodSelector.svelte';
  import type { CsvCell } from '$lib/csv';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const { report, presets, activeKey } = $derived(data);

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const total = $derived(Number(report.totalExpenses));
  // Biggest spend first — the "where did it go" lens. share is % of total.
  const rows = $derived(
    [...report.expenses]
      .map((e) => ({ ...e, share: total > 0 ? (Number(e.amount) / total) * 100 : 0 }))
      .sort((a, b) => Number(b.amount) - Number(a.amount)),
  );

  const csvRows = $derived<CsvCell[][]>([
    ['Code', 'Category', 'Tax line', 'Amount', 'Share %'],
    ...rows.map(
      (e) => [e.code, e.name, e.taxMapping ?? '', e.amount, e.share.toFixed(1)] as CsvCell[],
    ),
    ['', 'Total expenses', '', report.totalExpenses, ''],
  ]);
</script>

<div class="flex flex-wrap items-baseline justify-between gap-6">
  <div>
    <a href="/reports" class="eyebrow text-fg/60 hover:text-fg">← Reports</a>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      Expenses by category<span class="text-accent">.</span>
    </h1>
  </div>
  <ExportCsvButton
    filename="expenses-by-category_{report.from}_{report.to}"
    rows={csvRows}
    disabled={rows.length === 0}
  />
</div>

<PeriodSelector {presets} {activeKey} from={report.from} to={report.to} />

<p class="mt-4 text-sm text-fg/60">
  <!-- Deliberately doesn't name a tax form: the categories map to whichever return
       the business files (Schedule C / 1065 / 1120-S / 1120), and each row already
       prints its own tax line. -->
  {report.from} → {report.to}. Spending grouped by tax category, biggest first.
</p>

{#if rows.length === 0}
  <p class="mt-8 text-fg/70">No expenses recorded in this period.</p>
{:else}
  <div class="mt-8 overflow-hidden rounded-sm border border-fg/10 bg-surface-2">
    <table class="w-full text-left text-sm">
      <thead class="bg-surface">
        <tr class="label">
          <th class="px-5 py-3">Category</th>
          <th class="w-1/3 px-5 py-3">Share</th>
          <th class="w-36 px-5 py-3 text-right">Amount</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-fg/10">
        {#each rows as e (e.code)}
          <tr>
            <td class="px-5 py-3">
              <span class="text-fg/80">{e.name}</span>
              {#if e.taxMapping}
                <span class="ml-2 font-mono text-xs text-fg/40">{e.taxMapping}</span>
              {/if}
            </td>
            <td class="px-5 py-3">
              <div class="flex items-center gap-2">
                <div class="h-2 flex-1 overflow-hidden rounded-full bg-fg/10">
                  <div class="h-full rounded-full bg-accent" style="width: {e.share}%"></div>
                </div>
                <span class="w-10 text-right font-mono text-xs tabular-nums text-fg/50">
                  {e.share.toFixed(0)}%
                </span>
              </div>
            </td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">{fmt(e.amount)}</td>
          </tr>
        {/each}
      </tbody>
      <tfoot class="border-t border-fg/10 bg-surface">
        <tr class="font-mono text-xs uppercase tracking-widest">
          <td class="px-5 py-3 text-fg/70">Total</td>
          <td></td>
          <td class="px-5 py-3 text-right text-base tabular-nums text-fg">
            {fmt(report.totalExpenses)}
          </td>
        </tr>
      </tfoot>
    </table>
  </div>
{/if}
