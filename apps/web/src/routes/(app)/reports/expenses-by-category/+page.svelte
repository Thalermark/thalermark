<script lang="ts">
  import PeriodSelector from '$lib/components/PeriodSelector.svelte';
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
</script>

<div>
  <span class="eyebrow">Reports</span>
  <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-ink">
    Expenses by category<span class="text-gold-deep">.</span>
  </h1>
</div>

<PeriodSelector {presets} {activeKey} from={report.from} to={report.to} />

<p class="mt-4 text-sm text-ink/60">
  {report.from} → {report.to}. Spending grouped by category (your Schedule C buckets), biggest
  first.
</p>

{#if rows.length === 0}
  <p class="mt-8 text-ink/70">No expenses recorded in this period.</p>
{:else}
  <div class="mt-8 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
    <table class="w-full text-left text-sm">
      <thead class="bg-cream">
        <tr class="font-mono text-xs uppercase tracking-widest text-ink/50">
          <th class="px-5 py-3">Category</th>
          <th class="w-1/3 px-5 py-3">Share</th>
          <th class="w-36 px-5 py-3 text-right">Amount</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-ink/10">
        {#each rows as e (e.code)}
          <tr>
            <td class="px-5 py-3">
              <span class="text-ink/80">{e.name}</span>
              {#if e.taxMapping}
                <span class="ml-2 font-mono text-xs text-ink/40">{e.taxMapping}</span>
              {/if}
            </td>
            <td class="px-5 py-3">
              <div class="flex items-center gap-2">
                <div class="h-2 flex-1 overflow-hidden rounded-full bg-ink/10">
                  <div class="h-full rounded-full bg-gold-deep" style="width: {e.share}%"></div>
                </div>
                <span class="w-10 text-right font-mono text-xs tabular-nums text-ink/50">
                  {e.share.toFixed(0)}%
                </span>
              </div>
            </td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-ink">{fmt(e.amount)}</td>
          </tr>
        {/each}
      </tbody>
      <tfoot class="border-t border-ink/10 bg-cream">
        <tr class="font-mono text-xs uppercase tracking-widest">
          <td class="px-5 py-3 text-ink/70">Total</td>
          <td></td>
          <td class="px-5 py-3 text-right text-base tabular-nums text-ink">
            {fmt(report.totalExpenses)}
          </td>
        </tr>
      </tfoot>
    </table>
  </div>
{/if}
