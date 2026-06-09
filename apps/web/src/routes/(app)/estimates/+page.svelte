<script lang="ts">
  import LoadMore from '$lib/components/LoadMore.svelte';
  import { fetchMore } from '$lib/load-more';
  import { untrack } from 'svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  // See /customers for the untrack() seed-and-re-seed pattern.
  type Row = (typeof data.estimates)[number];
  let rows = $state<Row[]>(untrack(() => data.estimates));
  let cursor = $state<string | null>(untrack(() => data.nextCursor));
  let loading = $state(false);
  let loadError = $state(false);

  $effect(() => {
    const nextRows = data.estimates;
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
      const page = await fetchMore<Row>('/estimates/more', cursor);
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

{#if rows.length === 0}
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
        {#each rows as est (est.id)}
          <tr class="hover:bg-cream">
            <td class="px-5 py-4">
              <a href="/estimates/{est.id}" class="font-serif text-ink hover:text-gold-deep">
                {est.number}
              </a>
            </td>
            <td class="px-5 py-4 text-ink/80">{est.customerName ?? '—'}</td>
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
  <LoadMore hasMore={cursor !== null} {loading} error={loadError} onclick={more} />
{/if}
