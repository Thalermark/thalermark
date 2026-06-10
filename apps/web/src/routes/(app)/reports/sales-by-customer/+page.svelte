<script lang="ts">
  import PeriodSelector from '$lib/components/PeriodSelector.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const { report, presets, activeKey } = $derived(data);

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const total = $derived(Number(report.totalSales));
  const rows = $derived(
    report.customers.map((c) => ({
      ...c,
      share: total > 0 ? (Number(c.sales) / total) * 100 : 0,
    })),
  );
</script>

<div>
  <span class="eyebrow">Reports</span>
  <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-ink">
    Sales by customer<span class="text-gold-deep">.</span>
  </h1>
</div>

<PeriodSelector {presets} {activeKey} from={report.from} to={report.to} />

<p class="mt-4 text-sm text-ink/60">
  {report.from} → {report.to}. Pre-tax sales from sent or paid invoices, top 25 customers by
  revenue.
</p>

{#if rows.length === 0}
  <p class="mt-8 text-ink/70">No sales in this period.</p>
{:else}
  <div class="mt-8 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
    <table class="w-full text-left text-sm">
      <thead class="bg-cream">
        <tr class="font-mono text-xs uppercase tracking-widest text-ink/50">
          <th class="px-5 py-3">Customer</th>
          <th class="w-1/3 px-5 py-3">Share</th>
          <th class="w-20 px-5 py-3 text-right">Invoices</th>
          <th class="w-36 px-5 py-3 text-right">Sales</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-ink/10">
        {#each rows as c (c.customerId)}
          <tr>
            <td class="px-5 py-3">
              <a href="/customers/{c.customerId}" class="text-ink hover:text-gold-deep">
                {c.name ?? '—'}
              </a>
            </td>
            <td class="px-5 py-3">
              <div class="flex items-center gap-2">
                <div class="h-2 flex-1 overflow-hidden rounded-full bg-ink/10">
                  <div class="h-full rounded-full bg-gold-deep" style="width: {c.share}%"></div>
                </div>
                <span class="w-10 text-right font-mono text-xs tabular-nums text-ink/50">
                  {c.share.toFixed(0)}%
                </span>
              </div>
            </td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-ink/70">{c.invoiceCount}</td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-ink">{fmt(c.sales)}</td>
          </tr>
        {/each}
      </tbody>
      <tfoot class="border-t border-ink/10 bg-cream">
        <tr class="font-mono text-xs uppercase tracking-widest">
          <td class="px-5 py-3 text-ink/70">Total</td>
          <td></td>
          <td></td>
          <td class="px-5 py-3 text-right text-base tabular-nums text-ink">
            {fmt(report.totalSales)}
          </td>
        </tr>
      </tfoot>
    </table>
  </div>
{/if}
