<script lang="ts">
  import LoadMore from '$lib/components/LoadMore.svelte';
  import { fetchMore } from '$lib/load-more';
  import { may } from '$lib/perms';
  import { untrack } from 'svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const { filters } = $derived(data);
  const anyFilter = $derived(Boolean(filters.q || filters.openInvoices));

  // Seed local state from page 1; untrack() so Svelte doesn't fire the
  // state_referenced_locally warning — capturing the initial value is exactly
  // what we want, and the $effect below re-seeds when load() re-runs.
  type Row = (typeof data.contacts)[number];
  let rows = $state<Row[]>(untrack(() => data.contacts));
  let cursor = $state<string | null>(untrack(() => data.nextCursor));
  let loading = $state(false);
  let loadError = $state(false);

  $effect(() => {
    const nextRows = data.contacts;
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
      const page = await fetchMore<Row>('/contacts/more', cursor, {
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
    <span class="eyebrow">Contacts</span>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      All contacts<span class="text-accent">.</span>
    </h1>
  </div>
  {#if may(data.role, 'contacts:write')}
    <a
      href="/contacts/new"
      class="btn"
    >
      + New contact
    </a>
  {/if}
</div>

<!-- Filters. Plain GET form so they live in the URL (shareable, back-button
     friendly) and re-run load() with a fresh page 1. -->
<form
  method="GET"
  class="mt-8 flex flex-wrap items-end gap-3 rounded-sm border border-fg/10 bg-surface-2 p-4"
>
  <label class="flex flex-1 flex-col gap-1 text-xs uppercase tracking-widest text-fg/50">
    Search
    <input
      type="search"
      name="q"
      value={filters.q}
      placeholder="Name or email"
      class="min-w-40 rounded-sm border border-fg/15 bg-surface px-2 py-1.5 text-sm normal-case tracking-normal text-fg"
    />
  </label>
  <label class="flex items-center gap-2 py-1.5 text-sm text-fg">
    <input
      type="checkbox"
      name="openInvoices"
      value="true"
      checked={filters.openInvoices}
      onchange={(e) => e.currentTarget.form?.requestSubmit()}
      class="rounded-sm border-fg/30 text-accent focus:ring-accent"
    />
    Has open invoices
  </label>
  <button
    type="submit"
    class="btn"
  >
    Filter
  </button>
  {#if anyFilter}
    <a href="/contacts" class="text-sm text-fg/60 hover:text-fg">Clear</a>
  {/if}
</form>

{#if rows.length === 0}
  <p class="mt-8 text-fg/70">
    {anyFilter ? 'No contacts match these filters.' : 'No contacts yet.'}
  </p>
{:else}
  <ul class="mt-8 divide-y divide-fg/10 rounded-sm border border-fg/10 bg-surface-2">
    {#each rows as c (c.id)}
      <li>
        <a
          href="/contacts/{c.id}"
          class="flex items-center justify-between px-5 py-4 transition-colors hover:bg-surface"
        >
          <span class="font-serif text-lg text-fg">{c.name}</span>
          <span class="label">
            {c.email ?? ''}
          </span>
        </a>
      </li>
    {/each}
  </ul>
  <LoadMore hasMore={cursor !== null} {loading} error={loadError} onclick={more} />
{/if}
