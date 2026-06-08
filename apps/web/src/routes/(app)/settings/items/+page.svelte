<script lang="ts">
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

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
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-ink">
      Products &amp; services<span class="text-gold-deep">.</span>
    </h1>
  </div>
  <a
    href="/settings/items/new"
    class="rounded-sm bg-ink px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
  >
    + New item
  </a>
</div>

<p class="mt-3 text-sm text-ink/60">
  A reusable catalog you can pull into any invoice, estimate, or recurring schedule.
</p>

<div class="mt-6">
  <a
    href={data.showArchived ? '/settings/items' : '/settings/items?archived=1'}
    class="font-mono text-xs uppercase tracking-widest text-ink/50 hover:text-gold-deep"
  >
    {data.showArchived ? '← Hide archived' : 'Show archived'}
  </a>
</div>

{#if data.items.length === 0}
  <p class="mt-8 text-ink/70">
    {data.showArchived ? 'No items yet.' : 'No active items yet.'}
  </p>
{:else}
  <ul class="mt-6 divide-y divide-ink/10 rounded-sm border border-ink/10 bg-cream-warm">
    {#each data.items as item (item.id)}
      <li class="flex items-center justify-between gap-4 px-5 py-4">
        <a href="/settings/items/{item.id}" class="min-w-0 flex-1 transition-colors hover:opacity-70">
          <span class="font-serif text-lg text-ink">{item.name}</span>
          {#if item.archivedAt}
            <span
              class="ml-2 rounded-sm border border-ink/15 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-widest text-ink/50"
            >
              Archived
            </span>
          {/if}
        </a>
        <span class="font-mono text-xs uppercase tracking-widest text-ink/50">
          {priceLabel(item.unitPrice, item.unitLabel)}
        </span>
        <form method="post" action={item.archivedAt ? '?/restore' : '?/archive'}>
          <input type="hidden" name="id" value={item.id} />
          <button
            type="submit"
            class="rounded-sm border border-ink/15 px-2 py-1 font-mono text-xs uppercase tracking-widest text-ink/60 transition-colors hover:border-gold-deep hover:text-gold-deep"
          >
            {item.archivedAt ? 'Restore' : 'Archive'}
          </button>
        </form>
      </li>
    {/each}
  </ul>
{/if}
