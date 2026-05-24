<script lang="ts">
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<span class="eyebrow">Invoices</span>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-ink">
  All invoices<span class="text-gold-deep">.</span>
</h1>

{#if data.invoices.length === 0}
  <p class="mt-8 text-ink/70">No invoices yet.</p>
{:else}
  <div class="mt-8 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
    <table class="w-full text-left text-sm">
      <thead class="bg-cream">
        <tr class="font-mono text-xs uppercase tracking-widest text-ink/50">
          <th class="px-5 py-3">Number</th>
          <th class="px-5 py-3">Customer</th>
          <th class="px-5 py-3">Status</th>
          <th class="px-5 py-3">Due</th>
          <th class="px-5 py-3 text-right">Total</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-ink/10">
        {#each data.invoices as inv (inv.id)}
          <tr class="hover:bg-cream">
            <td class="px-5 py-4">
              <a href="/invoices/{inv.id}" class="font-serif text-ink hover:text-gold-deep">
                {inv.number}
              </a>
            </td>
            <td class="px-5 py-4 text-ink/80">{inv.customerName}</td>
            <td class="px-5 py-4">
              <span class="font-mono text-xs uppercase tracking-widest text-ink/60">
                {inv.status}
              </span>
            </td>
            <td class="px-5 py-4 text-ink/80">{inv.dueDate}</td>
            <td class="px-5 py-4 text-right font-mono tabular-nums text-ink">
              {inv.currency} {inv.total}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
