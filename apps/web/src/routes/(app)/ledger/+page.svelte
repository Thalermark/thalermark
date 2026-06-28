<script lang="ts">
  import LoadMore from '$lib/components/LoadMore.svelte';
  import { fetchMore } from '$lib/load-more';
  import { may } from '$lib/perms';
  import { untrack } from 'svelte';
  import type { PageProps } from './$types';
  import type { LedgerRow } from './ledger-rows';

  let { data }: PageProps = $props();

  const companyId = $derived(data.companyId);
  const canAdjust = $derived(may(data.role, 'ledger:adjust'));

  let rows = $state<LedgerRow[]>(untrack(() => data.rows));
  let cursor = $state<string | null>(untrack(() => data.nextCursor));
  let loading = $state(false);
  let loadError = $state(false);

  $effect(() => {
    const nextRows = data.rows;
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
      const page = await fetchMore<LedgerRow>('/ledger/more', cursor, { companyId });
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
    <span class="eyebrow text-accent">The Ledger</span>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      Journal entries<span class="text-accent">.</span>
    </h1>
  </div>
  {#if canAdjust}
    <a href="/ledger/new" class="btn">+ New entry</a>
  {/if}
</div>

<p class="mt-4 max-w-2xl text-sm text-fg/60">
  Manual adjustments your accountant tells you to make — debits, credits, and journal entries.
  Each entry is permanent; a mistake is fixed by reversing it, never editing.
</p>

{#if rows.length === 0}
  <p class="mt-8 text-fg/70">No manual entries yet.</p>
{:else}
  <div class="mt-6 overflow-hidden rounded-sm border border-fg/10 bg-surface-2">
    <table class="w-full text-left text-sm">
      <thead class="bg-surface">
        <tr class="label">
          <th class="px-5 py-3">Date</th>
          <th class="px-5 py-3">Description</th>
          <th class="px-5 py-3 text-right">Amount</th>
          <th class="px-5 py-3">Status</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-fg/10">
        {#each rows as entry (entry.id)}
          <tr class="hover:bg-surface">
            <td class="px-5 py-4 font-mono tabular-nums text-fg/80">{entry.date}</td>
            <td class="px-5 py-4">
              <a href="/ledger/{entry.id}" class="font-serif text-fg hover:text-accent">
                {entry.memo ?? 'Journal entry'}
              </a>
            </td>
            <td class="px-5 py-4 text-right font-mono tabular-nums text-fg">{entry.amount}</td>
            <td class="px-5 py-4">
              {#if entry.reversed}
                <span
                  class="rounded-sm border border-fg/20 px-2 py-0.5 font-mono text-xs uppercase tracking-widest text-fg/50"
                >
                  Reversed
                </span>
              {:else}
                <span class="font-mono text-xs uppercase tracking-widest text-fg/40">Posted</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <LoadMore hasMore={cursor !== null} {loading} error={loadError} onclick={more} />
{/if}
