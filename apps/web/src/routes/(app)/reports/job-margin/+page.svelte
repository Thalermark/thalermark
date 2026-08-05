<script lang="ts">
  import ExportCsvButton from '$lib/components/ExportCsvButton.svelte';
  import PeriodSelector from '$lib/components/PeriodSelector.svelte';
  import type { CsvCell } from '$lib/csv';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const { report, presets, activeKey } = $derived(data);

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const shared = $derived(Number(report.totals.shared));
  const unattributed = $derived(Number(report.totals.unattributed));

  const csvRows = $derived<CsvCell[][]>([
    ['Job', 'Customer', 'Date', 'Billed', 'Costs', 'Made'],
    ...report.jobs.map(
      (j) =>
        [j.number, j.customerName ?? '', j.issueDate, j.billed, j.costs, j.made] as CsvCell[],
    ),
    ['Shared costs', '', '', '', report.totals.shared, ''],
    ['Total', '', '', report.totals.billed, report.totals.jobCosts, report.totals.made],
  ]);
</script>

<div class="flex flex-wrap items-baseline justify-between gap-6">
  <div>
    <a href="/reports" class="eyebrow text-fg/60 hover:text-fg">← Reports</a>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      What each job made<span class="text-accent">.</span>
    </h1>
  </div>
  <ExportCsvButton
    filename="job-margin_{report.from}_{report.to}"
    rows={csvRows}
    disabled={report.jobs.length === 0}
  />
</div>

<PeriodSelector {presets} {activeKey} from={report.from} to={report.to} />

<p class="mt-4 text-sm text-fg/60">
  {report.from} → {report.to}. Billed is pre-tax. Costs are the ones you said were for that job —
  tag a receipt with a job to see it here.
</p>

{#if report.jobs.length === 0}
  <p class="mt-8 text-fg/70">No sent invoices in this period.</p>
{:else}
  <div class="mt-8 overflow-x-auto rounded-sm border border-fg/10 bg-surface-2">
    <table class="w-full text-left text-sm">
      <thead class="bg-surface">
        <tr class="label">
          <th class="px-5 py-3">Job</th>
          <th class="px-5 py-3">Date</th>
          <th class="w-32 px-5 py-3 text-right">Billed</th>
          <th class="w-32 px-5 py-3 text-right">Costs</th>
          <th class="w-32 px-5 py-3 text-right">Made</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-fg/10">
        {#each report.jobs as j (j.invoiceId)}
          <tr>
            <td class="px-5 py-3">
              <a href="/invoices/{j.invoiceId}" class="text-fg hover:text-accent">
                {j.customerName ?? '—'}
              </a>
              <span class="ml-2 font-mono text-xs text-fg/40">{j.number}</span>
            </td>
            <td class="px-5 py-3 text-fg/60">{j.issueDate}</td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-fg/70">{fmt(j.billed)}</td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-fg/70">
              {Number(j.costs) > 0 ? `−${fmt(j.costs).replace('$', '$')}` : '—'}
            </td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">{fmt(j.made)}</td>
          </tr>
        {/each}
      </tbody>
      <tfoot class="border-t border-fg/10 bg-surface">
        <!--
          Shared costs get their own line and are never spread across the jobs
          above. Splitting a cost the user declined to split would invent a
          precision he never gave, and he would trust the number.
        -->
        {#if shared > 0}
          <tr class="text-fg/70">
            <td class="px-5 py-3" colspan="3">
              Shared costs
              <span class="ml-2 text-xs text-fg/50">not counted against any one job</span>
            </td>
            <td class="px-5 py-3 text-right font-mono tabular-nums">−{fmt(report.totals.shared)}</td>
            <td></td>
          </tr>
        {/if}
        <tr class="font-mono text-xs uppercase tracking-widest">
          <td class="px-5 py-3 text-fg/70" colspan="2">Total</td>
          <td class="px-5 py-3 text-right tabular-nums text-fg/70">{fmt(report.totals.billed)}</td>
          <td class="px-5 py-3 text-right tabular-nums text-fg/70">
            −{fmt(report.totals.jobCosts)}
          </td>
          <td class="px-5 py-3 text-right text-base tabular-nums text-fg">
            {fmt(report.totals.made)}
          </td>
        </tr>
      </tfoot>
    </table>
  </div>

  <!--
    Costs he never answered for. Shown rather than hidden so the totals here
    can be reconciled against the P&L instead of quietly disagreeing with it.
  -->
  {#if unattributed > 0}
    <p class="mt-4 text-sm text-fg/60">
      {fmt(report.totals.unattributed)} of spending in this period isn't tagged to a job yet, so it
      isn't in the numbers above. Open an expense and answer “what was this for?” to include it.
    </p>
  {/if}
{/if}
