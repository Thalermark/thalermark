<script lang="ts">
  import EmptyState from '$lib/components/EmptyState.svelte';
  import LoadMore from '$lib/components/LoadMore.svelte';
  import { fetchMore } from '$lib/load-more';
  import { may } from '$lib/perms';
  import { untrack } from 'svelte';
  import type { PageProps } from './$types';
  import type { BillRow } from './bill-rows';

  let { data }: PageProps = $props();

  const { filters } = $derived(data);
  const companyId = $derived(data.companyId);

  const STATUSES = [
    { key: '', label: 'All' },
    { key: 'open', label: 'Open' },
    { key: 'paid', label: 'Paid' },
    { key: 'voided', label: 'Voided' },
  ];

  // Seed-and-re-seed via untrack(), the list pattern across the app. The status
  // filter is a link, so changing it navigates here and re-runs load().
  let rows = $state<BillRow[]>(untrack(() => data.rows));
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

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  // Open + past its due date = overdue; surfaced with a subtle marker.
  const today = new Date().toISOString().slice(0, 10);

  function statusClass(status: string): string {
    return status === 'paid'
      ? 'bg-accent/15 text-accent'
      : status === 'voided'
        ? 'bg-fg/10 text-fg/50'
        : 'bg-warning/15 text-warning';
  }

  async function more() {
    if (loading || cursor === null) return;
    loading = true;
    loadError = false;
    try {
      const page = await fetchMore<BillRow>('/bills/more', cursor, {
        companyId,
        status: filters.status,
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
    <span class="eyebrow">Bills</span>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      What you owe<span class="text-accent">.</span>
    </h1>
    <!-- A byline rather than a second item in the button row. As a grey link at
         the same baseline as a solid "+ New bill" it read as a weak competing
         CTA, and the arrow made it look like the primary action's sibling. Under
         the title it reads as what it is: more detail about this page. -->
    <p class="mt-2">
      <a href="/bills/aging" class="text-sm text-fg/60 hover:text-fg">Who to pay first →</a>
    </p>
  </div>
  <div class="flex items-center gap-4">
    {#if may(data.role, 'expenses:write')}
      <a href="/bills/new" class="btn">+ New bill</a>
    {/if}
  </div>
</div>

<!-- Hidden when there is genuinely nothing to filter. A full filter bar over an
     empty list offers several ways to slice zero rows, which is noise at exactly
     the moment a new user needs one clear next action. It stays visible whenever
     a filter IS applied, because then it is the way back out (TMC-234). -->
{#if rows.length > 0 || filters.status}
<!-- Status filter. Plain links so the filter lives in the URL. -->
<div class="mt-8 flex flex-wrap gap-2">
  {#each STATUSES as s (s.key)}
    <a
      href={s.key ? `/bills?status=${s.key}` : '/bills'}
      class="rounded-sm border px-3 py-1 font-mono text-xs uppercase tracking-widest transition-colors {filters.status ===
      s.key
        ? 'border-accent text-accent'
        : 'border-fg/15 text-fg/60 hover:border-fg/40 hover:text-fg'}"
    >
      {s.label}
    </a>
  {/each}
</div>
{/if}

{#if rows.length === 0}
  <!-- Filtered-empty and never-created are different problems: one wants the
       filter undone, the other wants the thing made. Offering "+ New bill" to
       someone whose filters merely hid their rows answers the wrong question
       (TMC-234). -->
  {#if Boolean(filters.status)}
    <EmptyState message="No bills with this status." actionHref="/bills" actionLabel="Clear filters" />
  {:else}
    <EmptyState
      message="No bills yet."
      actionHref={may(data.role, 'expenses:write') ? '/bills/new' : undefined}
      actionLabel={may(data.role, 'expenses:write') ? '+ New bill' : undefined}
    />
  {/if}
{:else}
  <div class="mt-6 overflow-hidden rounded-sm border border-fg/10 bg-surface-2">
    <table class="w-full text-left text-sm">
      <thead class="bg-surface">
        <tr class="label">
          <th class="px-5 py-3">Vendor</th>
          <th class="px-5 py-3">Due</th>
          <th class="px-5 py-3">Status</th>
          <th class="px-5 py-3 text-right">Amount</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-fg/10">
        {#each rows as bill (bill.id)}
          {@const overdue = bill.status === 'open' && bill.dueDate < today}
          <tr class="hover:bg-surface">
            <td class="px-5 py-4">
              <a href="/bills/{bill.id}" class="font-serif text-fg hover:text-accent">
                {bill.vendorName}
              </a>
              {#if bill.reference}
                <span class="ml-2 align-middle font-mono text-xs text-fg/40">#{bill.reference}</span>
              {/if}
            </td>
            <td class="px-5 py-4 font-mono tabular-nums text-fg/80">
              {bill.dueDate}
              {#if overdue}
                <span class="ml-1 text-xs font-medium uppercase tracking-wide text-danger">overdue</span>
              {/if}
            </td>
            <td class="px-5 py-4">
              <span
                class="rounded-sm px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide {statusClass(
                  bill.status,
                )}"
              >
                {bill.status}
              </span>
            </td>
            <td class="px-5 py-4 text-right font-mono tabular-nums text-fg">{fmt(bill.amount)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <LoadMore hasMore={cursor !== null} {loading} error={loadError} onclick={more} />
{/if}
