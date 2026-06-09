<script lang="ts">
  import LoadMore from '$lib/components/LoadMore.svelte';
  import { fetchMore } from '$lib/load-more';
  import { untrack } from 'svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

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
      const page = await fetchMore<Row>('/customers/more', cursor);
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

{#if rows.length === 0}
  <p class="mt-8 text-ink/70">No customers yet.</p>
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
