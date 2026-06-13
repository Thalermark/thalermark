<script lang="ts">
  import ExportCsvButton from '$lib/components/ExportCsvButton.svelte';
  import PeriodSelector from '$lib/components/PeriodSelector.svelte';
  import type { CsvCell } from '$lib/csv';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const { report, presets, activeKey } = $derived(data);

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const byStatus = $derived(new Map(report.byStatus.map((s) => [s.status, s])));
  // Win-first display order with friendly labels.
  const ROWS = [
    { status: 'accepted', label: 'Accepted', tone: 'text-fg' },
    { status: 'declined', label: 'Declined', tone: 'text-danger' },
    { status: 'expired', label: 'Expired', tone: 'text-fg/60' },
    { status: 'sent', label: 'Sent (awaiting)', tone: 'text-fg/60' },
    { status: 'draft', label: 'Draft', tone: 'text-fg/60' },
  ];

  const winPct = $derived(report.winRate === null ? null : Math.round(Number(report.winRate) * 100));

  const csvRows = $derived<CsvCell[][]>([
    ['Status', 'Count', 'Value'],
    ...ROWS.map((r) => {
      const s = byStatus.get(r.status);
      return [r.label, s?.count ?? 0, s?.value ?? '0.00'] as CsvCell[];
    }),
    ['Win rate %', winPct ?? '', ''],
  ]);
</script>

<div class="flex flex-wrap items-baseline justify-between gap-6">
  <div>
    <a href="/reports" class="eyebrow text-fg/60 hover:text-fg">← Reports</a>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      Estimate win rate<span class="text-accent">.</span>
    </h1>
  </div>
  <ExportCsvButton filename="estimate-win-rate_{report.from}_{report.to}" rows={csvRows} />
</div>

<PeriodSelector {presets} {activeKey} from={report.from} to={report.to} />

<p class="mt-4 text-sm text-fg/60">
  {report.from} → {report.to}. Of the estimates you've heard back on (accepted, declined, or
  expired), how many turned into work.
</p>

<div class="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
  <div class="rounded-sm border border-fg/10 bg-surface-2 p-5">
    <div class="label">Win rate</div>
    <div class="mt-2 font-serif text-4xl font-light text-fg">
      {winPct === null ? '—' : `${winPct}%`}
    </div>
    <div class="mt-1 text-xs text-fg/50">
      {#if winPct === null}
        Nothing decided yet
      {:else}
        {report.acceptedCount} of {report.decidedCount} decided
      {/if}
    </div>
  </div>
</div>

<div class="mt-4 overflow-hidden rounded-sm border border-fg/10 bg-surface-2">
  <table class="w-full text-left text-sm">
    <thead class="bg-surface">
      <tr class="label">
        <th class="px-5 py-3">Status</th>
        <th class="w-24 px-5 py-3 text-right">Count</th>
        <th class="w-36 px-5 py-3 text-right">Value</th>
      </tr>
    </thead>
    <tbody class="divide-y divide-fg/10">
      {#each ROWS as r (r.status)}
        {@const row = byStatus.get(r.status)}
        <tr>
          <td class="px-5 py-3 {r.tone}">{r.label}</td>
          <td class="px-5 py-3 text-right font-mono tabular-nums text-fg/70">{row?.count ?? 0}</td>
          <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">
            {fmt(row?.value ?? '0.00')}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
