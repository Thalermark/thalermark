<script lang="ts">
  import LoadMore from '$lib/components/LoadMore.svelte';
  import MetricStrip from '$lib/components/MetricStrip.svelte';
  import { fetchMore } from '$lib/load-more';
  import { may } from '$lib/perms';
  import { untrack } from 'svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const { filters, contacts, summary } = $derived(data);
  const STATUSES = ['draft', 'sent', 'paid', 'voided'];
  // Any filter active → show the "Clear" affordance + the "none match" empty copy.
  const anyFilter = $derived(
    Boolean(
      filters.status ||
        filters.q ||
        filters.from ||
        filters.to ||
        filters.contactId ||
        filters.overdue ||
        filters.awaiting,
    ),
  );

  // Display-only currency format; the decimal string from the API stays
  // authoritative. Position figures sit within Number's safe range.
  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  // Point-in-time metric strip. Draft = count only; Awaiting / Overdue carry
  // outstanding $ (they partition the sent-but-unpaid pool by due date, so the
  // amounts don't double-count). Tiles deep-link to the matching filter.
  const strip = $derived([
    {
      label: 'Draft',
      value: summary?.draft.count ?? 0,
      href: '/invoices?status=draft',
      active: filters.status === 'draft',
    },
    {
      label: 'Awaiting',
      value: summary?.awaiting.count ?? 0,
      sub: fmt(summary?.awaiting.total ?? '0'),
      href: '/invoices?awaiting=true',
      active: filters.awaiting === 'true',
    },
    {
      label: 'Overdue',
      value: summary?.overdue.count ?? 0,
      sub: fmt(summary?.overdue.total ?? '0'),
      href: '/invoices?overdue=true',
      active: filters.overdue === 'true',
      alert: (summary?.overdue.count ?? 0) > 0,
    },
  ]);

  // See /contacts for the untrack() seed-and-re-seed pattern.
  type Row = (typeof data.invoices)[number];
  let rows = $state<Row[]>(untrack(() => data.invoices));
  let cursor = $state<string | null>(untrack(() => data.nextCursor));
  let loading = $state(false);
  let loadError = $state(false);

  $effect(() => {
    const nextRows = data.invoices;
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
      const page = await fetchMore<Row>('/invoices/more', cursor, {
        status: filters.status,
        q: filters.q,
        from: filters.from,
        to: filters.to,
        contactId: filters.contactId,
        overdue: filters.overdue,
        awaiting: filters.awaiting,
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
    <span class="eyebrow">Invoices</span>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      All invoices<span class="text-accent">.</span>
    </h1>
  </div>
  {#if may(data.role, 'sales:write')}
    <a
      href="/invoices/new"
      class="btn"
    >
      + New invoice
    </a>
  {/if}
</div>

<div class="mt-8">
  <MetricStrip tiles={strip} />
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
      placeholder="Number or contact"
      class="min-w-40 rounded-sm border border-fg/15 bg-surface px-2 py-1.5 text-sm normal-case tracking-normal text-fg"
    />
  </label>
  <label class="flex flex-col gap-1 text-xs uppercase tracking-widest text-fg/50">
    Status
    <select
      name="status"
      onchange={(e) => e.currentTarget.form?.requestSubmit()}
      class="rounded-sm border border-fg/15 bg-surface px-2 py-1.5 text-sm normal-case tracking-normal text-fg"
    >
      <option value="" selected={filters.status === ''}>All</option>
      {#each STATUSES as s (s)}
        <option value={s} selected={filters.status === s}>{s}</option>
      {/each}
    </select>
  </label>
  <label class="flex flex-col gap-1 text-xs uppercase tracking-widest text-fg/50">
    Contact
    <select
      name="contactId"
      onchange={(e) => e.currentTarget.form?.requestSubmit()}
      class="rounded-sm border border-fg/15 bg-surface px-2 py-1.5 text-sm normal-case tracking-normal text-fg"
    >
      <option value="" selected={filters.contactId === ''}>All</option>
      {#each contacts as c (c.id)}
        <option value={c.id} selected={filters.contactId === c.id}>{c.name}</option>
      {/each}
    </select>
  </label>
  <label class="flex flex-col gap-1 text-xs uppercase tracking-widest text-fg/50">
    Issued from
    <input
      type="date"
      name="from"
      value={filters.from}
      class="rounded-sm border border-fg/15 bg-surface px-2 py-1.5 text-sm normal-case tracking-normal text-fg"
    />
  </label>
  <label class="flex flex-col gap-1 text-xs uppercase tracking-widest text-fg/50">
    To
    <input
      type="date"
      name="to"
      value={filters.to}
      class="rounded-sm border border-fg/15 bg-surface px-2 py-1.5 text-sm normal-case tracking-normal text-fg"
    />
  </label>
  <button
    type="submit"
    class="btn"
  >
    Filter
  </button>
  {#if anyFilter}
    <a href="/invoices" class="text-sm text-fg/60 hover:text-fg">Clear</a>
  {/if}
</form>

{#if rows.length === 0}
  <p class="mt-8 text-fg/70">
    {anyFilter ? 'No invoices match these filters.' : 'No invoices yet.'}
  </p>
{:else}
  <div class="mt-8 overflow-hidden rounded-sm border border-fg/10 bg-surface-2">
    <table class="w-full text-left text-sm">
      <thead class="bg-surface">
        <tr class="label">
          <th class="px-5 py-3">Number</th>
          <th class="px-5 py-3">Contact</th>
          <th class="px-5 py-3">Status</th>
          <th class="px-5 py-3">Due</th>
          <th class="px-5 py-3 text-right">Total</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-fg/10">
        {#each rows as inv (inv.id)}
          <tr class="hover:bg-surface">
            <td class="px-5 py-4">
              <a href="/invoices/{inv.id}" class="font-serif text-fg hover:text-accent">
                {inv.number}
              </a>
            </td>
            <td class="px-5 py-4 text-fg/80">{inv.customerName ?? '—'}</td>
            <td class="px-5 py-4">
              <span class="label">
                {inv.status}
              </span>
            </td>
            <td class="px-5 py-4 text-fg/80">{inv.dueDate}</td>
            <td class="px-5 py-4 text-right font-mono tabular-nums text-fg">
              {inv.currency} {inv.total}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <LoadMore hasMore={cursor !== null} {loading} error={loadError} onclick={more} />
{/if}
