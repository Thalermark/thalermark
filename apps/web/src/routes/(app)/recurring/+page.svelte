<script lang="ts">
  import { cadenceLabel } from '$lib/recurring';
  import LoadMore from '$lib/components/LoadMore.svelte';
  import { fetchMore } from '$lib/load-more';
  import { may } from '$lib/perms';
  import { untrack } from 'svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  // See /contacts for the untrack() seed-and-re-seed pattern.
  type Row = (typeof data.schedules)[number];
  let rows = $state<Row[]>(untrack(() => data.schedules));
  let cursor = $state<string | null>(untrack(() => data.nextCursor));
  let loading = $state(false);
  let loadError = $state(false);

  $effect(() => {
    const nextRows = data.schedules;
    const next = data.nextCursor;
    untrack(() => {
      rows = nextRows;
      cursor = next;
    });
  });

  async function more() {
    if (loading || cursor === null) return;
    loading = true;
    loadError = false;
    try {
      const page = await fetchMore<Row>('/recurring/more', cursor);
      rows = [...rows, ...page.rows];
      cursor = page.nextCursor;
    } catch {
      loadError = true;
    } finally {
      loading = false;
    }
  }
</script>

<div class="flex items-baseline justify-between gap-6">
  <div>
    <span class="eyebrow">Recurring</span>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      Recurring invoices<span class="text-accent">.</span>
    </h1>
  </div>
  {#if may(data.role, 'sales:write')}
    <a
      href="/recurring/new"
      class="btn"
    >
      + New schedule
    </a>
  {/if}
</div>

{#if rows.length === 0}
  <p class="mt-8 text-fg/70">
    No recurring schedules yet. Set one up to auto-generate and email invoices on a cadence.
  </p>
{:else}
  <div class="mt-8 overflow-hidden rounded-sm border border-fg/10 bg-surface-2">
    <table class="w-full text-left text-sm">
      <thead class="bg-surface">
        <tr class="label">
          <th class="px-5 py-3">Contact</th>
          <th class="px-5 py-3">Cadence</th>
          <th class="px-5 py-3">Next run</th>
          <th class="px-5 py-3">Status</th>
          <th class="px-5 py-3 text-right">Total</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-fg/10">
        {#each rows as s (s.id)}
          <tr class="hover:bg-surface">
            <td class="px-5 py-4">
              <a href="/recurring/{s.id}" class="font-serif text-fg hover:text-accent">
                {s.customerName ?? '—'}
              </a>
            </td>
            <td class="px-5 py-4 text-fg/80">{cadenceLabel(s.frequency, s.intervalCount)}</td>
            <td class="px-5 py-4 font-mono tabular-nums text-fg/80">
              {s.status === 'ended' ? '—' : s.nextRunDate}
            </td>
            <td class="px-5 py-4">
              <span class="font-mono text-xs uppercase tracking-widest text-fg/60">
                {s.status}
              </span>
            </td>
            <td class="px-5 py-4 text-right font-mono tabular-nums text-fg">
              {s.currency} {s.total}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <LoadMore hasMore={cursor !== null} {loading} error={loadError} onclick={more} />
{/if}
