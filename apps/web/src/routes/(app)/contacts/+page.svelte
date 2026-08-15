<script lang="ts">
  import EmptyState from '$lib/components/EmptyState.svelte';
  import ImportExportActions from '$lib/components/ImportExportActions.svelte';
  import LoadMore from '$lib/components/LoadMore.svelte';
  import MetricStrip from '$lib/components/MetricStrip.svelte';
  import { fetchMore } from '$lib/load-more';
  import { may } from '$lib/perms';
  import { untrack } from 'svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const { filters, summary } = $derived(data);
  const anyFilter = $derived(Boolean(filters.q || filters.openInvoices || filters.role));
  // Same gate the New-contact button uses; the API enforces it regardless, this
  // just keeps a dead control off the screen for a read-only member.
  const canWrite = $derived(may(data.role, 'contacts:write'));

  // Point-in-time roster strip (counts only — no money on the contacts page).
  // A contact can be both a customer and a vendor, so those slices overlap by
  // design and don't sum to Total. Tiles deep-link to the matching filter.
  const strip = $derived([
    { label: 'Total', value: summary?.total ?? 0, href: '/contacts', active: !anyFilter },
    {
      label: 'Customers',
      value: summary?.customers ?? 0,
      href: '/contacts?role=customer',
      active: filters.role === 'customer',
    },
    {
      label: 'Vendors',
      value: summary?.vendors ?? 0,
      href: '/contacts?role=vendor',
      active: filters.role === 'vendor',
    },
    {
      label: 'With open invoices',
      value: summary?.withOpenInvoices ?? 0,
      href: '/contacts?openInvoices=true',
      active: filters.openInvoices,
    },
  ]);

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
        role: filters.role,
        includeArchived: data.showArchived ? 'true' : '',
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
  <div class="flex items-center gap-2">
    <ImportExportActions entity="contacts" role={data.role} />
    {#if may(data.role, 'contacts:write')}
      <a href="/contacts/new" class="btn"> + New contact </a>
    {/if}
  </div>
</div>

<div class="mt-8">
  <MetricStrip tiles={strip} />
</div>

<!-- Hidden when there is genuinely nothing to filter. A full filter bar over an
     empty list offers several ways to slice zero rows, which is noise at exactly
     the moment a new user needs one clear next action. It stays visible whenever
     a filter IS applied, because then it is the way back out (TMC-234). -->
{#if rows.length > 0 || anyFilter}
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
{/if}

<div class="mt-6">
  <a
    href={data.showArchived ? '/contacts' : '/contacts?archived=1'}
    class="label hover:text-accent"
  >
    {data.showArchived ? '← Hide archived' : 'Show archived'}
  </a>
</div>

{#if rows.length === 0}
  <!-- Filtered-empty and never-created are different problems: one wants the
       filter undone, the other wants the thing made. Offering "+ New contact" to
       someone whose filters merely hid their rows answers the wrong question
       (TMC-234). -->
  {#if anyFilter}
    <EmptyState message="No contacts match these filters." actionHref="/contacts" actionLabel="Clear filters" />
  {:else}
    <EmptyState
      message="No contacts yet."
      actionHref={may(data.role, 'contacts:write') ? '/contacts/new' : undefined}
      actionLabel={may(data.role, 'contacts:write') ? '+ New contact' : undefined}
    />
  {/if}
{:else}
  <ul class="mt-8 divide-y divide-fg/10 rounded-sm border border-fg/10 bg-surface-2">
    {#each rows as c (c.id)}
      <!--
        The row is a flex container rather than one big <a>: the archive control
        is a form, and a form nested inside an anchor is invalid HTML. Same
        layout the items list uses.
      -->
      <li class="flex items-center justify-between gap-4 px-5 py-4">
        <a href="/contacts/{c.id}" class="min-w-0 flex-1 transition-colors hover:opacity-70">
          <span class="font-serif text-lg text-fg">{c.name}</span>
          {#if c.archivedAt}
            <span
              class="ml-2 rounded-sm border border-fg/15 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-widest text-fg/50"
            >
              Archived
            </span>
          {/if}
        </a>
        <span class="label">
          {c.email ?? ''}
        </span>
        {#if canWrite}
          <form method="post" action={c.archivedAt ? '?/restore' : '?/archive'}>
            <input type="hidden" name="id" value={c.id} />
            <button
              type="submit"
              class="rounded-sm border border-fg/15 px-2 py-1 font-mono text-xs uppercase tracking-widest text-fg/60 transition-colors hover:border-accent hover:text-accent"
            >
              {c.archivedAt ? 'Restore' : 'Archive'}
            </button>
          </form>
        {/if}
      </li>
    {/each}
  </ul>
  <LoadMore hasMore={cursor !== null} {loading} error={loadError} onclick={more} />
{/if}
