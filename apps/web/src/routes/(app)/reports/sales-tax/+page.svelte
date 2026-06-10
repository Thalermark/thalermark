<script lang="ts">
  import PeriodSelector from '$lib/components/PeriodSelector.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const { report, presets, activeKey } = $derived(data);

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
</script>

<div>
  <span class="eyebrow">Reports</span>
  <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-ink">
    Sales tax collected<span class="text-gold-deep">.</span>
  </h1>
</div>

<PeriodSelector {presets} {activeKey} from={report.from} to={report.to} />

<p class="mt-4 text-sm text-ink/60">
  {report.from} → {report.to}. Sales tax billed on your invoices, net of voids — what you've
  collected to remit. Awareness, not tax advice.
</p>

<div class="mt-8 rounded-sm border border-ink/10 bg-cream-warm p-5">
  <div class="font-mono text-xs uppercase tracking-widest text-ink/50">Total collected</div>
  <div class="mt-2 font-serif text-4xl font-light text-ink">{fmt(report.total)}</div>
</div>

{#if report.months.length > 0}
  <div class="mt-4 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
    <table class="w-full text-left text-sm">
      <thead class="bg-cream">
        <tr class="font-mono text-xs uppercase tracking-widest text-ink/50">
          <th class="px-5 py-3">Month</th>
          <th class="px-5 py-3 text-right">Collected</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-ink/10">
        {#each report.months as m (m.month)}
          <tr>
            <td class="px-5 py-3 font-mono tabular-nums text-ink/80">{m.month}</td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-ink">{fmt(m.collected)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
