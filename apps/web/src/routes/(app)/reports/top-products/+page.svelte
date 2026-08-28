<script lang="ts">
  import ExportCsvButton from '$lib/components/ExportCsvButton.svelte';
  import type { CsvCell } from '$lib/csv';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const totalRaw = $derived(
    data.products.reduce((sum, p) => sum + Number(p.revenue), 0).toFixed(2),
  );
  const total = $derived(
    Number(totalRaw).toLocaleString('en-US', { style: 'currency', currency: 'USD' }),
  );

  // Both branches describe what is counted rather than naming the accounting
  // basis; the 'paid' one used to append "(cash basis)" and its sibling never
  // did, so the term leaked on one toggle position and not the other (TMC-233).
  // The sentence already says "paid invoices only", which is the same fact in
  // words the reader has.
  const basisNote = $derived(
    data.basis === 'sent'
      ? 'Pre-tax revenue from invoices that have been sent or paid.'
      : 'Pre-tax revenue from paid invoices only.',
  );

  const csvRows = $derived<CsvCell[][]>([
    ['Product', 'Lines', 'Revenue'],
    ...data.products.map(
      (p) => [p.name ?? 'Uncatalogued / other', p.lineCount, p.revenue] as CsvCell[],
    ),
    ['Total', '', totalRaw],
  ]);
</script>

<div class="flex flex-wrap items-baseline justify-between gap-6">
  <div>
    <a href="/reports" class="eyebrow text-fg/60 hover:text-fg">← Reports</a>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      Top products<span class="text-accent">.</span>
    </h1>
  </div>
  <div class="flex items-center gap-3">
    <div class="flex items-center gap-1 rounded-sm border border-fg/15 bg-surface-2 p-1 font-mono text-xs uppercase tracking-widest">
      <a
        href="/reports/top-products"
        class="rounded-sm px-3 py-1 transition-colors {data.basis === 'paid'
          ? 'bg-inverse text-on-inverse'
          : 'text-fg/60 hover:text-fg'}"
      >
        Paid
      </a>
      <a
        href="/reports/top-products?basis=sent"
        class="rounded-sm px-3 py-1 transition-colors {data.basis === 'sent'
          ? 'bg-inverse text-on-inverse'
          : 'text-fg/60 hover:text-fg'}"
      >
        Sent
      </a>
    </div>
    <ExportCsvButton
      filename="top-products_{data.basis}"
      rows={csvRows}
      disabled={data.products.length === 0}
    />
  </div>
</div>

<p class="mt-3 text-sm text-fg/60">
  {basisNote} The top 25 by revenue, plus an “Uncatalogued / other” row for hand-typed lines. A
  sales lens, not a tax figure.
</p>

{#if data.products.length === 0}
  <p class="mt-8 text-fg/70">No sales yet.</p>
{:else}
  <div class="mt-8 overflow-hidden rounded-sm border border-fg/10 bg-surface-2">
    <table class="w-full text-left text-sm">
      <thead class="bg-surface">
        <tr class="label">
          <th class="px-5 py-3">Product</th>
          <th class="w-24 px-5 py-3 text-right">Lines</th>
          <th class="w-36 px-5 py-3 text-right">Revenue</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-fg/10">
        {#each data.products as p (p.sourceItemId ?? 'uncatalogued')}
          <tr>
            <td class="px-5 py-3">
              {#if p.name}
                <a href="/items/{p.sourceItemId}" class="text-fg hover:text-accent">
                  {p.name}
                </a>
              {:else}
                <span class="text-fg/50 italic">Uncatalogued / other</span>
              {/if}
            </td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-fg/70">{p.lineCount}</td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">{fmt(p.revenue)}</td>
          </tr>
        {/each}
      </tbody>
      <tfoot class="border-t border-fg/10 bg-surface">
        <tr class="font-mono text-xs uppercase tracking-widest">
          <td class="px-5 py-3 text-fg/70">Total</td>
          <td></td>
          <td class="px-5 py-3 text-right text-base tabular-nums text-fg">{total}</td>
        </tr>
      </tfoot>
    </table>
  </div>
{/if}
