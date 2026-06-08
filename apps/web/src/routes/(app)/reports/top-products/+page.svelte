<script lang="ts">
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const total = $derived(
    data.products.reduce((sum, p) => sum + Number(p.revenue), 0).toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
    }),
  );

  const basisNote = $derived(
    data.basis === 'sent'
      ? 'Pre-tax revenue from invoices that have been sent or paid.'
      : 'Pre-tax revenue from paid invoices only (cash basis).',
  );
</script>

<div class="flex items-baseline justify-between gap-6">
  <div>
    <span class="eyebrow">Reports</span>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-ink">
      Top products<span class="text-gold-deep">.</span>
    </h1>
  </div>
  <div class="flex items-center gap-1 rounded-sm border border-ink/15 bg-cream-warm p-1 font-mono text-xs uppercase tracking-widest">
    <a
      href="/reports/top-products"
      class="rounded-sm px-3 py-1 transition-colors {data.basis === 'paid'
        ? 'bg-ink text-cream'
        : 'text-ink/60 hover:text-ink'}"
    >
      Paid
    </a>
    <a
      href="/reports/top-products?basis=sent"
      class="rounded-sm px-3 py-1 transition-colors {data.basis === 'sent'
        ? 'bg-ink text-cream'
        : 'text-ink/60 hover:text-ink'}"
    >
      Sent
    </a>
  </div>
</div>

<p class="mt-3 text-sm text-ink/60">
  {basisNote} A sales lens, not a tax figure — the “Uncatalogued / other” row collects hand-typed
  lines so the rows tie back to revenue.
</p>

{#if data.products.length === 0}
  <p class="mt-8 text-ink/70">No sales yet on this basis.</p>
{:else}
  <div class="mt-8 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
    <table class="w-full text-left text-sm">
      <thead class="bg-cream">
        <tr class="font-mono text-xs uppercase tracking-widest text-ink/50">
          <th class="px-5 py-3">Product</th>
          <th class="w-24 px-5 py-3 text-right">Lines</th>
          <th class="w-36 px-5 py-3 text-right">Revenue</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-ink/10">
        {#each data.products as p (p.sourceItemId ?? 'uncatalogued')}
          <tr>
            <td class="px-5 py-3">
              {#if p.name}
                <a href="/settings/items/{p.sourceItemId}" class="text-ink hover:text-gold-deep">
                  {p.name}
                </a>
              {:else}
                <span class="text-ink/50 italic">Uncatalogued / other</span>
              {/if}
            </td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-ink/70">{p.lineCount}</td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-ink">{fmt(p.revenue)}</td>
          </tr>
        {/each}
      </tbody>
      <tfoot class="border-t border-ink/10 bg-cream">
        <tr class="font-mono text-xs uppercase tracking-widest">
          <td class="px-5 py-3 text-ink/70">Total</td>
          <td></td>
          <td class="px-5 py-3 text-right text-base tabular-nums text-ink">{total}</td>
        </tr>
      </tfoot>
    </table>
  </div>
{/if}
