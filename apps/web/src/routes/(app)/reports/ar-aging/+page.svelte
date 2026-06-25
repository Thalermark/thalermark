<script lang="ts">
  import AsOfSelector from '$lib/components/AsOfSelector.svelte';
  import ExportCsvButton from '$lib/components/ExportCsvButton.svelte';
  import type { CsvCell } from '$lib/csv';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const { report } = $derived(data);

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  // Overdue rows get progressively redder; current (not yet due) stays ink.
  const tone = (days: number) =>
    days <= 0 ? 'text-fg/70' : days <= 30 ? 'text-fg' : days <= 90 ? 'text-accent' : 'text-danger';

  // One row per open invoice — the detail an accountant chases against.
  const csvRows = $derived<CsvCell[][]>([
    ['Invoice', 'Contact', 'Due date', 'Days past due', 'Amount'],
    ...report.invoices.map(
      (inv) =>
        [inv.number, inv.customerName ?? '', inv.dueDate, inv.daysPastDue, inv.amount] as CsvCell[],
    ),
    ['', '', '', 'Total', report.total],
  ]);
</script>

<div class="flex flex-wrap items-baseline justify-between gap-6">
  <div>
    <a href="/reports" class="eyebrow text-fg/60 hover:text-fg">← Reports</a>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      A/R aging<span class="text-accent">.</span>
    </h1>
  </div>
  <ExportCsvButton
    filename="ar-aging_{report.asOf}"
    rows={csvRows}
    disabled={report.invoices.length === 0}
  />
</div>

<AsOfSelector asOf={report.asOf} />

<p class="mt-4 text-sm text-fg/60">
  As of {report.asOf}. Sent invoices that haven't been paid, by how overdue they are.
</p>

<!-- Bucket summary -->
<div class="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-5">
  {#each report.buckets as b (b.key)}
    <div class="rounded-sm border border-fg/10 bg-surface-2 p-4">
      <div class="label">{b.label}</div>
      <div class="mt-2 font-mono text-lg tabular-nums text-fg">{fmt(b.amount)}</div>
      <div class="mt-0.5 text-xs text-fg/50">{b.count} invoice{b.count === 1 ? '' : 's'}</div>
    </div>
  {/each}
</div>

{#if report.invoices.length === 0}
  <p class="mt-8 text-fg/70">Nothing outstanding — you're all paid up.</p>
{:else}
  <div class="mt-6 overflow-hidden rounded-sm border border-fg/10 bg-surface-2">
    <table class="w-full text-left text-sm">
      <thead class="bg-surface">
        <tr class="label">
          <th class="px-5 py-3">Number</th>
          <th class="px-5 py-3">Contact</th>
          <th class="px-5 py-3">Due</th>
          <th class="px-5 py-3 text-right">Overdue</th>
          <th class="px-5 py-3 text-right">Amount</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-fg/10">
        {#each report.invoices as inv (inv.id)}
          <tr class="hover:bg-surface">
            <td class="px-5 py-3">
              <a href="/invoices/{inv.id}" class="font-serif text-fg hover:text-accent">
                {inv.number}
              </a>
            </td>
            <td class="px-5 py-3 text-fg/80">{inv.customerName ?? '—'}</td>
            <td class="px-5 py-3 text-fg/70">{inv.dueDate}</td>
            <td class="px-5 py-3 text-right font-mono tabular-nums {tone(inv.daysPastDue)}">
              {inv.daysPastDue <= 0 ? 'Current' : `${inv.daysPastDue}d`}
            </td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">{fmt(inv.amount)}</td>
          </tr>
        {/each}
      </tbody>
      <tfoot class="border-t border-fg/10 bg-surface">
        <tr class="font-mono text-xs uppercase tracking-widest">
          <td class="px-5 py-3 text-fg/70" colspan="4">Total outstanding</td>
          <td class="px-5 py-3 text-right text-base tabular-nums text-fg">{fmt(report.total)}</td>
        </tr>
      </tfoot>
    </table>
  </div>
{/if}
