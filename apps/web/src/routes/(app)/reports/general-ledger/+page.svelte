<script lang="ts">
  import ExportCsvButton from '$lib/components/ExportCsvButton.svelte';
  import PeriodSelector from '$lib/components/PeriodSelector.svelte';
  import type { CsvCell } from '$lib/csv';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const { report, presets, activeKey } = $derived(data);

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const from = $derived(report.from ?? '');
  const to = $derived(report.to ?? '');

  // The trial balance must net to zero across all accounts — show the totals so
  // an accountant can eyeball that the books balance.
  const totalDebit = $derived(report.trialBalance.reduce((s, t) => s + Number(t.debit), 0).toFixed(2));
  const totalCredit = $derived(
    report.trialBalance.reduce((s, t) => s + Number(t.credit), 0).toFixed(2),
  );

  // The export is the full journal: one row per line. Column names + order
  // match the server-side ledger export so the two artifacts are interchangeable.
  const csvRows = $derived<CsvCell[][]>([
    ['posted_at', 'entry_id', 'code', 'account_name', 'side', 'amount', 'source_type', 'source_id', 'memo'],
    ...report.entries.flatMap((e) =>
      e.lines.map(
        (l) =>
          [
            e.postedAt,
            e.id,
            l.code,
            l.accountName,
            l.side,
            l.amount,
            e.sourceEntityType,
            e.sourceEntityId,
            e.memo ?? '',
          ] as CsvCell[],
      ),
    ),
  ]);
</script>

<div class="flex flex-wrap items-baseline justify-between gap-6">
  <div>
    <a href="/reports" class="eyebrow text-ink/60 hover:text-ink">← Reports</a>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-ink">
      General ledger<span class="text-gold-deep">.</span>
    </h1>
  </div>
  <ExportCsvButton
    filename="general-ledger_{from}_{to}"
    rows={csvRows}
    label="Export ledger CSV"
    disabled={report.entries.length === 0}
  />
</div>

<PeriodSelector {presets} {activeKey} {from} {to} />

<p class="mt-4 text-sm text-ink/60">
  {from} → {to}. Every journal entry behind your invoices, payments, and expenses, summarised here
  as a trial balance. The CSV export contains the full detail — one row per journal line — for your
  accountant or tax software.
</p>

{#if report.entries.length === 0}
  <p class="mt-8 text-ink/70">No journal activity in this period.</p>
{:else}
  <div class="mt-8 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
    <table class="w-full text-left text-sm">
      <thead class="bg-cream">
        <tr class="font-mono text-xs uppercase tracking-widest text-ink/50">
          <th class="px-5 py-3">Code</th>
          <th class="px-5 py-3">Account</th>
          <th class="px-5 py-3 text-right">Debit</th>
          <th class="px-5 py-3 text-right">Credit</th>
          <th class="px-5 py-3 text-right">Net</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-ink/10">
        {#each report.trialBalance as t (t.code)}
          <tr>
            <td class="px-5 py-3 font-mono tabular-nums text-ink/60">{t.code}</td>
            <td class="px-5 py-3 text-ink/80">{t.accountName}</td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-ink">{fmt(t.debit)}</td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-ink">{fmt(t.credit)}</td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-ink">{fmt(t.net)}</td>
          </tr>
        {/each}
      </tbody>
      <tfoot class="border-t border-ink/10 bg-cream">
        <tr class="font-mono text-xs uppercase tracking-widest">
          <td class="px-5 py-3 text-ink/70" colspan="2">Total</td>
          <td class="px-5 py-3 text-right text-base tabular-nums text-ink">{fmt(totalDebit)}</td>
          <td class="px-5 py-3 text-right text-base tabular-nums text-ink">{fmt(totalCredit)}</td>
          <td></td>
        </tr>
      </tfoot>
    </table>
  </div>
{/if}
