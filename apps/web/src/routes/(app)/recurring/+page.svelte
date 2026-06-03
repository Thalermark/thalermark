<script lang="ts">
  import { cadenceLabel } from '$lib/recurring';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<div class="flex items-baseline justify-between gap-6">
  <div>
    <span class="eyebrow">Recurring</span>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-ink">
      Recurring invoices<span class="text-gold-deep">.</span>
    </h1>
  </div>
  <a
    href="/recurring/new"
    class="rounded-sm bg-ink px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
  >
    + New schedule
  </a>
</div>

{#if data.schedules.length === 0}
  <p class="mt-8 text-ink/70">
    No recurring schedules yet. Set one up to auto-generate and email invoices on a cadence.
  </p>
{:else}
  <div class="mt-8 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
    <table class="w-full text-left text-sm">
      <thead class="bg-cream">
        <tr class="font-mono text-xs uppercase tracking-widest text-ink/50">
          <th class="px-5 py-3">Customer</th>
          <th class="px-5 py-3">Cadence</th>
          <th class="px-5 py-3">Next run</th>
          <th class="px-5 py-3">Status</th>
          <th class="px-5 py-3 text-right">Total</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-ink/10">
        {#each data.schedules as s (s.id)}
          <tr class="hover:bg-cream">
            <td class="px-5 py-4">
              <a href="/recurring/{s.id}" class="font-serif text-ink hover:text-gold-deep">
                {s.customerName}
              </a>
            </td>
            <td class="px-5 py-4 text-ink/80">{cadenceLabel(s.frequency, s.intervalCount)}</td>
            <td class="px-5 py-4 font-mono tabular-nums text-ink/80">
              {s.status === 'ended' ? '—' : s.nextRunDate}
            </td>
            <td class="px-5 py-4">
              <span class="font-mono text-xs uppercase tracking-widest text-ink/60">
                {s.status}
              </span>
            </td>
            <td class="px-5 py-4 text-right font-mono tabular-nums text-ink">
              {s.currency} {s.total}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
