<script lang="ts">
  import LoadMore from '$lib/components/LoadMore.svelte';
  import { fetchMore } from '$lib/load-more';
  import { untrack } from 'svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const { filters, customers } = $derived(data);
  const STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired'];
  // Any filter active → show the "Clear" affordance + the "none match" empty copy.
  const anyFilter = $derived(
    Boolean(filters.status || filters.q || filters.from || filters.to || filters.customerId),
  );

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
      const page = await fetchMore<Row>('/estimates/more', cursor, {
        status: filters.status,
        q: filters.q,
        from: filters.from,
        to: filters.to,
        customerId: filters.customerId,
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
      placeholder="Number or customer"
      class="min-w-40 rounded-sm border border-ink/15 bg-cream px-2 py-1.5 text-sm normal-case tracking-normal text-ink"
    />
  </label>
  <label class="flex flex-col gap-1 text-xs uppercase tracking-widest text-ink/50">
    Status
    <select
      name="status"
      onchange={(e) => e.currentTarget.form?.requestSubmit()}
      class="rounded-sm border border-ink/15 bg-cream px-2 py-1.5 text-sm normal-case tracking-normal text-ink"
    >
      <option value="" selected={filters.status === ''}>All</option>
      {#each STATUSES as s (s)}
        <option value={s} selected={filters.status === s}>{s}</option>
      {/each}
    </select>
  </label>
  <label class="flex flex-col gap-1 text-xs uppercase tracking-widest text-ink/50">
    Customer
    <select
      name="customerId"
      onchange={(e) => e.currentTarget.form?.requestSubmit()}
      class="rounded-sm border border-ink/15 bg-cream px-2 py-1.5 text-sm normal-case tracking-normal text-ink"
    >
      <option value="" selected={filters.customerId === ''}>All</option>
      {#each customers as c (c.id)}
        <option value={c.id} selected={filters.customerId === c.id}>{c.name}</option>
      {/each}
    </select>
  </label>
  <label class="flex flex-col gap-1 text-xs uppercase tracking-widest text-ink/50">
    Issued from
    <input
      type="date"
      name="from"
      value={filters.from}
      class="rounded-sm border border-ink/15 bg-cream px-2 py-1.5 text-sm normal-case tracking-normal text-ink"
    />
  </label>
  <label class="flex flex-col gap-1 text-xs uppercase tracking-widest text-ink/50">
    To
    <input
      type="date"
      name="to"
      value={filters.to}
      class="rounded-sm border border-ink/15 bg-cream px-2 py-1.5 text-sm normal-case tracking-normal text-ink"
    />
  </label>
  <button
    type="submit"
    class="rounded-sm bg-ink px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
  >
    Filter
  </button>
  {#if anyFilter}
    <a href="/estimates" class="text-sm text-ink/60 hover:text-ink">Clear</a>
  {/if}
</form>

{#if rows.length === 0}
  <p class="mt-8 text-ink/70">
    {anyFilter ? 'No estimates match these filters.' : 'No estimates yet.'}
  </p>
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
