<script lang="ts">
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<div class="flex items-baseline justify-between gap-6">
  <div>
    <span class="eyebrow">Estimates</span>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-ink">
      All estimates<span class="text-gold-deep">.</span>
    </h1>
  </div>
  <a
    href="/estimates/new"
    class="rounded-sm bg-ink px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
  >
    + New estimate
  </a>
</div>

{#if data.estimates.length === 0}
  <p class="mt-8 text-ink/70">No estimates yet.</p>
{:else}
  <div class="mt-8 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
    <table class="w-full text-left text-sm">
      <thead class="bg-cream">
        <tr class="font-mono text-xs uppercase tracking-widest text-ink/50">
          <th class="px-5 py-3">Number</th>
          <th class="px-5 py-3">Customer</th>
          <th class="px-5 py-3">Status</th>
          <th class="px-5 py-3">Expires</th>
          <th class="px-5 py-3 text-right">Total</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-ink/10">
        {#each data.estimates as est (est.id)}
          <tr class="hover:bg-cream">
            <td class="px-5 py-4">
              <a href="/estimates/{est.id}" class="font-serif text-ink hover:text-gold-deep">
                {est.number}
              </a>
            </td>
            <td class="px-5 py-4 text-ink/80">{est.customerName}</td>
            <td class="px-5 py-4">
              <span class="font-mono text-xs uppercase tracking-widest text-ink/60">
                {est.status}
              </span>
            </td>
            <td class="px-5 py-4 text-ink/80">{est.expiresOn ?? '—'}</td>
            <td class="px-5 py-4 text-right font-mono tabular-nums text-ink">
              {est.currency} {est.total}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
