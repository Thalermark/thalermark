<script lang="ts">
  import AsOfSelector from '$lib/components/AsOfSelector.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const { report } = $derived(data);

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
</script>

<div>
  <span class="eyebrow">Reports</span>
  <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-ink">
    Balance sheet<span class="text-gold-deep">.</span>
  </h1>
</div>

<AsOfSelector asOf={report.asOf} />

<p class="mt-4 text-sm text-ink/60">
  As of {report.asOf}. What the business owns and owes. Assets equal liabilities plus equity —
  current-year net income is carried in equity as retained earnings.
</p>

<div class="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
  <!-- Assets -->
  <div class="overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
    <table class="w-full text-left text-sm">
      <thead class="bg-cream">
        <tr class="font-mono text-xs uppercase tracking-widest text-ink/50">
          <th class="px-5 py-3">Assets</th>
          <th class="px-5 py-3 text-right"></th>
        </tr>
      </thead>
      <tbody class="divide-y divide-ink/10">
        {#each report.assets as a (a.code)}
          <tr>
            <td class="px-5 py-3 text-ink/80">{a.name}</td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-ink">{fmt(a.amount)}</td>
          </tr>
        {:else}
          <tr><td colspan="2" class="px-5 py-3 text-ink/50 italic">No assets.</td></tr>
        {/each}
      </tbody>
      <tfoot class="border-t-2 border-ink/15 bg-cream">
        <tr class="font-mono text-xs uppercase tracking-widest">
          <td class="px-5 py-4 text-ink">Total assets</td>
          <td class="px-5 py-4 text-right text-base tabular-nums text-ink">
            {fmt(report.totalAssets)}
          </td>
        </tr>
      </tfoot>
    </table>
  </div>

  <!-- Liabilities + Equity -->
  <div class="overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
    <table class="w-full text-left text-sm">
      <tbody class="divide-y divide-ink/10">
        <tr class="bg-cream font-mono text-xs uppercase tracking-widest text-ink/50">
          <th colspan="2" class="px-5 py-3 text-left">Liabilities</th>
        </tr>
        {#each report.liabilities as l (l.code)}
          <tr>
            <td class="px-5 py-3 text-ink/80">{l.name}</td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-ink">{fmt(l.amount)}</td>
          </tr>
        {:else}
          <tr><td colspan="2" class="px-5 py-3 text-ink/50 italic">No liabilities.</td></tr>
        {/each}
        <tr class="border-t border-ink/10 font-mono text-xs uppercase tracking-widest">
          <td class="px-5 py-3 text-ink/70">Total liabilities</td>
          <td class="px-5 py-3 text-right tabular-nums text-ink">{fmt(report.totalLiabilities)}</td>
        </tr>

        <tr class="bg-cream font-mono text-xs uppercase tracking-widest text-ink/50">
          <th colspan="2" class="px-5 py-3 text-left">Equity</th>
        </tr>
        {#each report.equity as e (e.code)}
          <tr>
            <td class="px-5 py-3 text-ink/80">{e.name}</td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-ink">{fmt(e.amount)}</td>
          </tr>
        {/each}
        <tr>
          <td class="px-5 py-3 text-ink/80">Retained earnings (net income)</td>
          <td class="px-5 py-3 text-right font-mono tabular-nums text-ink">{fmt(report.netIncome)}</td>
        </tr>
        <tr class="border-t border-ink/10 font-mono text-xs uppercase tracking-widest">
          <td class="px-5 py-3 text-ink/70">Total equity</td>
          <td class="px-5 py-3 text-right tabular-nums text-ink">{fmt(report.totalEquity)}</td>
        </tr>
      </tbody>
      <tfoot class="border-t-2 border-ink/15 bg-cream">
        <tr class="font-mono text-xs uppercase tracking-widest">
          <td class="px-5 py-4 text-ink">Liabilities + equity</td>
          <td class="px-5 py-4 text-right text-base tabular-nums text-ink">
            {fmt(report.totalLiabilitiesAndEquity)}
          </td>
        </tr>
      </tfoot>
    </table>
  </div>
</div>

{#if !report.balanced}
  <p class="mt-4 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3 text-sm text-oxblood">
    This balance sheet doesn't balance — the ledger may have drifted. Please report this.
  </p>
{/if}
