<script lang="ts">
  import ExportCsvButton from '$lib/components/ExportCsvButton.svelte';
  import PeriodSelector from '$lib/components/PeriodSelector.svelte';
  import type { CsvCell } from '$lib/csv';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const { report, presets, activeKey } = $derived(data);

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const profitable = $derived(Number(report.netProfit) >= 0);

  // Raw decimal strings (not the formatted currency) so the CSV imports clean.
  const csvRows = $derived<CsvCell[][]>([
    ['Section', 'Code', 'Account', 'Amount'],
    ...report.revenue.map((r) => ['Revenue', r.code, r.name, r.amount] as CsvCell[]),
    ['Revenue', '', 'Total revenue', report.totalRevenue],
    ...report.expenses.map((e) => ['Expenses', e.code, e.name, e.amount] as CsvCell[]),
    ['Expenses', '', 'Total expenses', report.totalExpenses],
    ['', '', 'Net profit', report.netProfit],
  ]);
</script>

<div class="flex flex-wrap items-baseline justify-between gap-6">
  <div>
    <a href="/reports" class="eyebrow text-fg/60 hover:text-fg">← Reports</a>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      Profit &amp; loss<span class="text-accent">.</span>
    </h1>
  </div>
  <ExportCsvButton filename="profit-and-loss_{report.from}_{report.to}" rows={csvRows} />
</div>

<PeriodSelector {presets} {activeKey} from={report.from} to={report.to} />

<p class="mt-4 text-sm text-fg/60">
  {report.from} → {report.to}. Accrual basis: revenue is counted when an invoice is sent (or paid),
  expenses when recorded. This may differ from cash actually received.
</p>

<div class="mt-8 overflow-hidden rounded-sm border border-fg/10 bg-surface-2">
  <table class="w-full text-left text-sm">
    <tbody class="divide-y divide-fg/10">
      <!-- Revenue -->
      <tr class="bg-surface label">
        <th colspan="2" class="px-5 py-3 text-left">Revenue</th>
      </tr>
      {#each report.revenue as r (r.code)}
        <tr>
          <td class="px-5 py-3 text-fg/80">{r.name}</td>
          <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">{fmt(r.amount)}</td>
        </tr>
      {:else}
        <tr><td colspan="2" class="px-5 py-3 text-fg/50 italic">No revenue in this period.</td></tr>
      {/each}
      <tr class="border-t border-fg/10 font-mono text-xs uppercase tracking-widest">
        <td class="px-5 py-3 text-fg/70">Total revenue</td>
        <td class="px-5 py-3 text-right text-base tabular-nums text-fg">{fmt(report.totalRevenue)}</td>
      </tr>

      <!-- Expenses -->
      <tr class="bg-surface label">
        <th colspan="2" class="px-5 py-3 text-left">Expenses</th>
      </tr>
      {#each report.expenses as e (e.code)}
        <tr>
          <td class="px-5 py-3 text-fg/80">{e.name}</td>
          <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">{fmt(e.amount)}</td>
        </tr>
      {:else}
        <tr><td colspan="2" class="px-5 py-3 text-fg/50 italic">No expenses in this period.</td></tr>
      {/each}
      <tr class="border-t border-fg/10 font-mono text-xs uppercase tracking-widest">
        <td class="px-5 py-3 text-fg/70">Total expenses</td>
        <td class="px-5 py-3 text-right text-base tabular-nums text-fg">{fmt(report.totalExpenses)}</td>
      </tr>
    </tbody>
    <tfoot class="border-t-2 border-fg/15 bg-surface">
      <tr class="font-mono text-xs uppercase tracking-widest">
        <td class="px-5 py-4 text-fg">Net profit</td>
        <td
          class="px-5 py-4 text-right text-lg tabular-nums {profitable
            ? 'text-fg'
            : 'text-danger'}"
        >
          {fmt(report.netProfit)}
        </td>
      </tr>
    </tfoot>
  </table>
</div>
