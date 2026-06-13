<script lang="ts">
  import AsOfSelector from '$lib/components/AsOfSelector.svelte';
  import ExportCsvButton from '$lib/components/ExportCsvButton.svelte';
  import type { CsvCell } from '$lib/csv';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const { report } = $derived(data);

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const csvRows = $derived<CsvCell[][]>([
    ['Section', 'Code', 'Account', 'Amount'],
    ...report.assets.map((a) => ['Assets', a.code, a.name, a.amount] as CsvCell[]),
    ['Assets', '', 'Total assets', report.totalAssets],
    ...report.liabilities.map((l) => ['Liabilities', l.code, l.name, l.amount] as CsvCell[]),
    ['Liabilities', '', 'Total liabilities', report.totalLiabilities],
    ...report.equity.map((e) => ['Equity', e.code, e.name, e.amount] as CsvCell[]),
    ['Equity', '', 'Net income', report.netIncome],
    ['Equity', '', 'Total equity', report.totalEquity],
    ['', '', 'Total liabilities + equity', report.totalLiabilitiesAndEquity],
  ]);
</script>

<div class="flex flex-wrap items-baseline justify-between gap-6">
  <div>
    <a href="/reports" class="eyebrow text-fg/60 hover:text-fg">← Reports</a>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      Balance sheet<span class="text-accent">.</span>
    </h1>
  </div>
  <ExportCsvButton filename="balance-sheet_{report.asOf}" rows={csvRows} />
</div>

<AsOfSelector asOf={report.asOf} />

<p class="mt-4 text-sm text-fg/60">
  As of {report.asOf}. What the business owns and owes. Assets equal liabilities plus equity —
  current-year net income is carried in equity as retained earnings.
</p>

<div class="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
  <!-- Assets -->
  <div class="overflow-hidden rounded-sm border border-fg/10 bg-surface-2">
    <table class="w-full text-left text-sm">
      <thead class="bg-surface">
        <tr class="label">
          <th class="px-5 py-3">Assets</th>
          <th class="px-5 py-3 text-right"></th>
        </tr>
      </thead>
      <tbody class="divide-y divide-fg/10">
        {#each report.assets as a (a.code)}
          <tr>
            <td class="px-5 py-3 text-fg/80">{a.name}</td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">{fmt(a.amount)}</td>
          </tr>
        {:else}
          <tr><td colspan="2" class="px-5 py-3 text-fg/50 italic">No assets.</td></tr>
        {/each}
      </tbody>
      <tfoot class="border-t-2 border-fg/15 bg-surface">
        <tr class="font-mono text-xs uppercase tracking-widest">
          <td class="px-5 py-4 text-fg">Total assets</td>
          <td class="px-5 py-4 text-right text-base tabular-nums text-fg">
            {fmt(report.totalAssets)}
          </td>
        </tr>
      </tfoot>
    </table>
  </div>

  <!-- Liabilities + Equity -->
  <div class="overflow-hidden rounded-sm border border-fg/10 bg-surface-2">
    <table class="w-full text-left text-sm">
      <tbody class="divide-y divide-fg/10">
        <tr class="bg-surface label">
          <th colspan="2" class="px-5 py-3 text-left">Liabilities</th>
        </tr>
        {#each report.liabilities as l (l.code)}
          <tr>
            <td class="px-5 py-3 text-fg/80">{l.name}</td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">{fmt(l.amount)}</td>
          </tr>
        {:else}
          <tr><td colspan="2" class="px-5 py-3 text-fg/50 italic">No liabilities.</td></tr>
        {/each}
        <tr class="border-t border-fg/10 font-mono text-xs uppercase tracking-widest">
          <td class="px-5 py-3 text-fg/70">Total liabilities</td>
          <td class="px-5 py-3 text-right tabular-nums text-fg">{fmt(report.totalLiabilities)}</td>
        </tr>

        <tr class="bg-surface label">
          <th colspan="2" class="px-5 py-3 text-left">Equity</th>
        </tr>
        {#each report.equity as e (e.code)}
          <tr>
            <td class="px-5 py-3 text-fg/80">{e.name}</td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">{fmt(e.amount)}</td>
          </tr>
        {/each}
        <tr>
          <td class="px-5 py-3 text-fg/80">Retained earnings (net income)</td>
          <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">{fmt(report.netIncome)}</td>
        </tr>
        <tr class="border-t border-fg/10 font-mono text-xs uppercase tracking-widest">
          <td class="px-5 py-3 text-fg/70">Total equity</td>
          <td class="px-5 py-3 text-right tabular-nums text-fg">{fmt(report.totalEquity)}</td>
        </tr>
      </tbody>
      <tfoot class="border-t-2 border-fg/15 bg-surface">
        <tr class="font-mono text-xs uppercase tracking-widest">
          <td class="px-5 py-4 text-fg">Liabilities + equity</td>
          <td class="px-5 py-4 text-right text-base tabular-nums text-fg">
            {fmt(report.totalLiabilitiesAndEquity)}
          </td>
        </tr>
      </tfoot>
    </table>
  </div>
</div>

{#if !report.balanced}
  <p class="mt-4 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    This balance sheet doesn't balance — the ledger may have drifted. Please report this.
  </p>
{/if}
