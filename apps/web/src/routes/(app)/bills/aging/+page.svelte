<script lang="ts">
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const aging = $derived(data.aging);

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const BUCKETS = [
    { key: 'current', label: 'Current' },
    { key: 'd1_30', label: '1–30 days' },
    { key: 'd31_60', label: '31–60 days' },
    { key: 'd61_90', label: '61–90 days' },
    { key: 'd90_plus', label: '90+ days' },
  ] as const;

  const bucketLabel: Record<string, string> = {
    current: 'Current',
    d1_30: '1–30',
    d31_60: '31–60',
    d61_90: '61–90',
    d90_plus: '90+',
  };
</script>

<a href="/bills" class="eyebrow text-fg/60 hover:text-fg">← Bills</a>
<div class="mt-3 flex flex-wrap items-baseline justify-between gap-4">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
    Who to pay first<span class="text-accent">.</span>
  </h1>
  <span class="font-mono text-xs uppercase tracking-widest text-fg/50">as of {aging.asOf}</span>
</div>
<!-- Was "AP aging", an accountant's abbreviation on a screen aimed at someone
     who does not want to learn accounting. It cannot borrow the plain name the
     bills list already uses ("What you owe"), so it takes the action instead,
     mirroring how the A/R side reads as "who to chase". -->
<p class="mt-4 text-sm text-fg/60">Bills still to pay, by how far past due they are.</p>

<dl class="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
  {#each BUCKETS as b (b.key)}
    <div class="rounded-sm border border-fg/10 bg-surface-2 p-4">
      <dt class="label">{b.label}</dt>
      <dd class="mt-1 font-serif text-xl font-light tabular-nums text-fg">{fmt(aging.buckets[b.key])}</dd>
    </div>
  {/each}
  <div class="rounded-sm border border-accent/30 bg-accent/5 p-4">
    <dt class="label">Total</dt>
    <dd class="mt-1 font-serif text-xl font-light tabular-nums text-fg">{fmt(aging.total)}</dd>
  </div>
</dl>

{#if aging.bills.length === 0}
  <p class="mt-8 text-fg/70">No open bills — nothing outstanding.</p>
{:else}
  <div class="mt-8 overflow-hidden rounded-sm border border-fg/10 bg-surface-2">
    <table class="w-full text-left text-sm">
      <thead class="bg-surface">
        <tr class="label">
          <th class="px-5 py-3">Vendor</th>
          <th class="px-5 py-3">Due</th>
          <th class="px-5 py-3">Age</th>
          <th class="px-5 py-3 text-right">Amount</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-fg/10">
        {#each aging.bills as b (b.id)}
          <tr class="hover:bg-surface">
            <td class="px-5 py-4">
              <a href="/bills/{b.id}" class="font-serif text-fg hover:text-accent">{b.vendorName}</a>
              {#if b.reference}
                <span class="ml-2 font-mono text-xs text-fg/40">#{b.reference}</span>
              {/if}
            </td>
            <td class="px-5 py-4 font-mono tabular-nums text-fg/80">{b.dueDate}</td>
            <td class="px-5 py-4 text-fg/70">
              {bucketLabel[b.bucket] ?? b.bucket}
              {#if b.daysOverdue > 0}
                <span class="text-fg/40">· {b.daysOverdue}d</span>
              {/if}
            </td>
            <td class="px-5 py-4 text-right font-mono tabular-nums text-fg">{fmt(b.amount)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
