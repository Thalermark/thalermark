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
    <a href="/reports" class="eyebrow text-ink/60 hover:text-ink">← Reports</a>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-ink">
      Profit &amp; loss<span class="text-gold-deep">.</span>
    </h1>
  </div>
  <ExportCsvButton filename="profit-and-loss_{report.from}_{report.to}" rows={csvRows} />
</div>

<PeriodSelector {presets} {activeKey} from={report.from} to={report.to} />

<p class="mt-4 text-sm text-ink/60">
  {report.from} → {report.to}. Accrual basis: revenue is counted when an invoice is sent (or paid),
  expenses when recorded. This may differ from cash actually received.
</p>

<div class="mt-8 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
  <table class="w-full text-left text-sm">
    <tbody class="divide-y divide-ink/10">
      <!-- Revenue -->
      <tr class="bg-cream font-mono text-xs uppercase tracking-widest text-ink/50">
        <th colspan="2" class="px-5 py-3 text-left">Revenue</th>
      </tr>
      {#each report.revenue as r (r.code)}
        <tr>
          <td class="px-5 py-3 text-ink/80">{r.name}</td>
          <td class="px-5 py-3 text-right font-mono tabular-nums text-ink">{fmt(r.amount)}</td>
        </tr>
      {:else}
        <tr><td colspan="2" class="px-5 py-3 text-ink/50 italic">No revenue in this period.</td></tr>
      {/each}
      <tr class="border-t border-ink/10 font-mono text-xs uppercase tracking-widest">
        <td class="px-5 py-3 text-ink/70">Total revenue</td>
        <td class="px-5 py-3 text-right text-base tabular-nums text-ink">{fmt(report.totalRevenue)}</td>
      </tr>

      <!-- Expenses -->
      <tr class="bg-cream font-mono text-xs uppercase tracking-widest text-ink/50">
        <th colspan="2" class="px-5 py-3 text-left">Expenses</th>
      </tr>
      {#each report.expenses as e (e.code)}
        <tr>
          <td class="px-5 py-3 text-ink/80">{e.name}</td>
          <td class="px-5 py-3 text-right font-mono tabular-nums text-ink">{fmt(e.amount)}</td>
        </tr>
      {:else}
        <tr><td colspan="2" class="px-5 py-3 text-ink/50 italic">No expenses in this period.</td></tr>
      {/each}
      <tr class="border-t border-ink/10 font-mono text-xs uppercase tracking-widest">
        <td class="px-5 py-3 text-ink/70">Total expenses</td>
        <td class="px-5 py-3 text-right text-base tabular-nums text-ink">{fmt(report.totalExpenses)}</td>
      </tr>
    </tbody>
    <tfoot class="border-t-2 border-ink/15 bg-cream">
      <tr class="font-mono text-xs uppercase tracking-widest">
        <td class="px-5 py-4 text-ink">Net profit</td>
        <td
          class="px-5 py-4 text-right text-lg tabular-nums {profitable
            ? 'text-ink'
            : 'text-oxblood'}"
        >
          {fmt(report.netProfit)}
        </td>
      </tr>
    </tfoot>
  </table>
</div>
