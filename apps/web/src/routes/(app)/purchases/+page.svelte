<script lang="ts">
  import LoadMore from '$lib/components/LoadMore.svelte';
  import { fetchMore } from '$lib/load-more';
  import { may } from '$lib/perms';
  import { untrack } from 'svelte';
  import type { PageProps } from './$types';
  import type { PurchaseRow } from './purchase-rows';

  let { data }: PageProps = $props();

  const companyId = $derived(data.companyId);
  const canWrite = $derived(may(data.role, 'expenses:write'));
  const money = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  let rows = $state<PurchaseRow[]>(untrack(() => data.rows));
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
      const page = await fetchMore<PurchaseRow>('/purchases/more', cursor, { companyId });
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
    <span class="eyebrow">Big purchases</span>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      Things you bought<span class="text-accent">.</span>
    </h1>
  </div>
  {#if canWrite}
    <a href="/purchases/new" class="btn">+ Log a purchase</a>
  {/if}
</div>

<p class="mt-4 max-w-2xl text-sm text-fg/60">
  Big things you'll use for years — a mower, trailer, truck. We track what you paid, what you still
  owe, and how it helps at tax time.
</p>

{#if rows.length === 0}
  <p class="mt-8 text-fg/70">Nothing logged yet.</p>
{:else}
  <div class="mt-6 overflow-hidden rounded-sm border border-fg/10 bg-surface-2">
    <table class="w-full text-left text-sm">
      <thead class="bg-surface">
        <tr class="label">
          <th class="px-5 py-3">Date</th>
          <th class="px-5 py-3">What</th>
          <th class="px-5 py-3 text-right">Cost</th>
          <th class="px-5 py-3 text-right">Still owed</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-fg/10">
        {#each rows as p (p.id)}
          <tr class="hover:bg-surface">
            <td class="px-5 py-4 font-mono tabular-nums text-fg/80">{p.purchaseDate}</td>
            <td class="px-5 py-4">
              <a href="/purchases/{p.id}" class="font-serif text-fg hover:text-accent">
                {p.description}
              </a>
              {#if p.vendorName}
                <span class="block text-xs text-fg/50">from {p.vendorName}</span>
              {/if}
            </td>
            <td class="px-5 py-4 text-right font-mono tabular-nums text-fg">{money(p.amount)}</td>
            <td class="px-5 py-4 text-right font-mono tabular-nums">
              {#if p.stillOwes}
                <span class="text-fg">{money(p.owing)}</span>
              {:else}
                <span class="text-fg/40">Paid off</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <LoadMore hasMore={cursor !== null} {loading} error={loadError} onclick={more} />
{/if}
