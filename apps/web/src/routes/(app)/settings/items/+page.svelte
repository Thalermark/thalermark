<script lang="ts">
  import LoadMore from '$lib/components/LoadMore.svelte';
  import { fetchMore } from '$lib/load-more';
  import { may } from '$lib/perms';
  import { untrack } from 'svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const showArchived = $derived(data.showArchived);

  // See /customers for the untrack() seed-and-re-seed pattern. Here load()
  // re-runs on both the archived-toggle nav and the archive/restore POST
  // (which redirects back), so the $effect keeps the list in sync.
  type Row = (typeof data.items)[number];
  let rows = $state<Row[]>(untrack(() => data.items));
  let cursor = $state<string | null>(untrack(() => data.nextCursor));
  let loading = $state(false);
  let loadError = $state(false);

  $effect(() => {
    const nextRows = data.items;
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
      const page = await fetchMore<Row>('/settings/items/more', cursor, {
        archived: showArchived ? '1' : '',
      });
      rows = [...rows, ...page.rows];
      cursor = page.nextCursor;
    } catch {
      loadError = true;
    } finally {
      loading = false;
    }
  }

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  // Price line: "$65.00 / hour" when a unit label is set, otherwise the bare
  // amount. default_quantity is editor-side convenience, not shown in the list.
  function priceLabel(unitPrice: string, unitLabel: string | null): string {
    return unitLabel ? `${fmt(unitPrice)} / ${unitLabel}` : fmt(unitPrice);
  }
</script>

<div class="flex items-baseline justify-between gap-6">
  <div>
    <span class="eyebrow">Items</span>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      Products &amp; services<span class="text-accent">.</span>
    </h1>
  </div>
  {#if may(data.role, 'sales:write')}
    <a
      href="/settings/items/new"
      class="btn"
    >
      + New item
    </a>
  {/if}
</div>

<p class="mt-3 text-sm text-fg/60">
  A reusable catalog you can pull into any invoice, estimate, or recurring schedule.
</p>

<div class="mt-6">
  <a
    href={data.showArchived ? '/settings/items' : '/settings/items?archived=1'}
    class="label hover:text-accent"
  >
    {data.showArchived ? '← Hide archived' : 'Show archived'}
  </a>
</div>

{#if rows.length === 0}
  <p class="mt-8 text-fg/70">
    {data.showArchived ? 'No items yet.' : 'No active items yet.'}
  </p>
{:else}
  <ul class="mt-6 divide-y divide-fg/10 rounded-sm border border-fg/10 bg-surface-2">
    {#each rows as item (item.id)}
      <li class="flex items-center justify-between gap-4 px-5 py-4">
        <a href="/settings/items/{item.id}" class="min-w-0 flex-1 transition-colors hover:opacity-70">
          <span class="font-serif text-lg text-fg">{item.name}</span>
          {#if item.archivedAt}
            <span
              class="ml-2 rounded-sm border border-fg/15 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-widest text-fg/50"
            >
              Archived
            </span>
          {/if}
        </a>
        <span class="label">
          {priceLabel(item.unitPrice, item.unitLabel)}
        </span>
        <form method="post" action={item.archivedAt ? '?/restore' : '?/archive'}>
          <input type="hidden" name="id" value={item.id} />
          <button
            type="submit"
            class="rounded-sm border border-fg/15 px-2 py-1 font-mono text-xs uppercase tracking-widest text-fg/60 transition-colors hover:border-accent hover:text-accent"
          >
            {item.archivedAt ? 'Restore' : 'Archive'}
          </button>
        </form>
      </li>
    {/each}
  </ul>
  <LoadMore hasMore={cursor !== null} {loading} error={loadError} onclick={more} />
{/if}
