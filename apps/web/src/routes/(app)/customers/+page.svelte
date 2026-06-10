<script lang="ts">
  import LoadMore from '$lib/components/LoadMore.svelte';
  import { fetchMore } from '$lib/load-more';
  import { untrack } from 'svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const { filters } = $derived(data);
  const anyFilter = $derived(Boolean(filters.q || filters.openInvoices));

  // Seed local state from page 1; untrack() so Svelte doesn't fire the
  // state_referenced_locally warning — capturing the initial value is exactly
  // what we want, and the $effect below re-seeds when load() re-runs.
  type Row = (typeof data.customers)[number];
  let rows = $state<Row[]>(untrack(() => data.customers));
  let cursor = $state<string | null>(untrack(() => data.nextCursor));
  let loading = $state(false);
  let loadError = $state(false);

  $effect(() => {
    const nextRows = data.customers;
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
      const page = await fetchMore<Row>('/customers/more', cursor, {
        q: filters.q,
        openInvoices: filters.openInvoices ? 'true' : '',
      });
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
    <span class="eyebrow">Customers</span>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-ink">
      All customers<span class="text-gold-deep">.</span>
    </h1>
  </div>
  <a
    href="/customers/new"
    class="rounded-sm bg-ink px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
  >
    + New customer
  </a>
</div>

<!-- Filters. Plain GET form so they live in the URL (shareable, back-button
     friendly) and re-run load() with a fresh page 1. -->
<form
  method="GET"
  class="mt-8 flex flex-wrap items-end gap-3 rounded-sm border border-ink/10 bg-cream-warm p-4"
>
  <label class="flex flex-1 flex-col gap-1 text-xs uppercase tracking-widest text-ink/50">
    Search
    <input
      type="search"
      name="q"
      value={filters.q}
      placeholder="Name or email"
      class="min-w-40 rounded-sm border border-ink/15 bg-cream px-2 py-1.5 text-sm normal-case tracking-normal text-ink"
    />
  </label>
  <label class="flex items-center gap-2 py-1.5 text-sm text-ink">
    <input
      type="checkbox"
      name="openInvoices"
      value="true"
      checked={filters.openInvoices}
      class="rounded-sm border-ink/30 text-gold-deep focus:ring-gold-deep"
    />
    Has open invoices
  </label>
  <button
    type="submit"
    class="rounded-sm bg-ink px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
  >
    Filter
  </button>
  {#if anyFilter}
    <a href="/customers" class="text-sm text-ink/60 hover:text-ink">Clear</a>
  {/if}
</form>

{#if rows.length === 0}
  <p class="mt-8 text-ink/70">
    {anyFilter ? 'No customers match these filters.' : 'No customers yet.'}
  </p>
{:else}
  <ul class="mt-8 divide-y divide-ink/10 rounded-sm border border-ink/10 bg-cream-warm">
    {#each rows as c (c.id)}
      <li>
        <a
          href="/customers/{c.id}"
          class="flex items-center justify-between px-5 py-4 transition-colors hover:bg-cream"
        >
          <span class="font-serif text-lg text-ink">{c.name}</span>
          <span class="font-mono text-xs uppercase tracking-widest text-ink/50">
            {c.email ?? ''}
          </span>
        </a>
      </li>
    {/each}
  </ul>
  <LoadMore hasMore={cursor !== null} {loading} error={loadError} onclick={more} />
{/if}
