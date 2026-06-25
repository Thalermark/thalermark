<script lang="ts">
  import LoadMore from '$lib/components/LoadMore.svelte';
  import { fetchMore } from '$lib/load-more';
  import { may } from '$lib/perms';
  import { untrack } from 'svelte';
  import type { PageProps } from './$types';
  import type { ExpenseRow } from './expense-rows';

  let { data }: PageProps = $props();

  const { filters } = $derived(data);
  const companyId = $derived(data.companyId);
  const hasFilters = $derived(
    !!(filters.from || filters.to || filters.category || filters.q || filters.needsReview),
  );

  // See /contacts for the untrack() seed-and-re-seed pattern. The filter form
  // is a GET, so applying/clearing filters navigates here, re-runs load(), and
  // the $effect re-seeds with the new filter set's page 1.
  let rows = $state<ExpenseRow[]>(untrack(() => data.rows));
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
      const page = await fetchMore<ExpenseRow>('/expenses/more', cursor, {
        companyId,
        from: filters.from,
        to: filters.to,
        category: filters.category,
        q: filters.q,
        needsReview: filters.needsReview ? 'true' : '',
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
    <span class="eyebrow">Expenses</span>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      All expenses<span class="text-accent">.</span>
    </h1>
  </div>
  {#if may(data.role, 'expenses:write')}
    <a
      href="/expenses/new"
      class="btn"
    >
      + New expense
    </a>
  {/if}
</div>

<!-- Filter bar. Plain GET form so filters live in the URL (shareable,
     back-button friendly) and the page works without JS. -->
<form
  method="GET"
  class="mt-8 grid grid-cols-1 gap-3 rounded-sm border border-fg/10 bg-surface-2 p-4 sm:grid-cols-5"
>
  <label class="flex flex-col gap-1 text-xs uppercase tracking-widest text-fg/50">
    From
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
  <label class="flex flex-col gap-1 text-xs uppercase tracking-widest text-fg/50">
    Category
    <select
      name="category"
      onchange={(e) => e.currentTarget.form?.requestSubmit()}
      class="rounded-sm border border-fg/15 bg-surface px-2 py-1.5 text-sm normal-case tracking-normal text-fg"
    >
      <option value="" selected={filters.category === ''}>All</option>
      {#each data.categories as cat (cat.id)}
        <option value={cat.id} selected={filters.category === cat.id}>{cat.label}</option>
      {/each}
    </select>
  </label>
  <label class="flex flex-col gap-1 text-xs uppercase tracking-widest text-fg/50">
    Vendor
    <input
      type="search"
      name="q"
      value={filters.q}
      placeholder="Search…"
      class="rounded-sm border border-fg/15 bg-surface px-2 py-1.5 text-sm normal-case tracking-normal text-fg"
    />
  </label>
  <div class="flex items-end gap-3">
    <button
      type="submit"
      class="btn"
    >
      Filter
    </button>
    <a href="/expenses" class="text-sm text-fg/60 hover:text-fg">Clear</a>
  </div>
  <!-- Needs-review: receipt-backed expenses with no vendor linked yet. Auto-
       submits so toggling it re-runs the list with a fresh page 1. -->
  <label class="flex items-center gap-2 py-1.5 text-sm text-fg sm:col-span-5">
    <input
      type="checkbox"
      name="needsReview"
      value="true"
      checked={filters.needsReview}
      onchange={(ev) => ev.currentTarget.form?.requestSubmit()}
      class="rounded-sm border-fg/30 text-accent focus:ring-accent"
    />
    Needs review (no vendor on a receipt)
  </label>
</form>

{#if rows.length === 0}
  <p class="mt-8 text-fg/70">
    {hasFilters ? 'No expenses match these filters.' : 'No expenses yet.'}
  </p>
{:else}
  <div class="mt-6 overflow-hidden rounded-sm border border-fg/10 bg-surface-2">
    <table class="w-full text-left text-sm">
      <thead class="bg-surface">
        <tr class="label">
          <th class="px-5 py-3">Date</th>
          <th class="px-5 py-3">Vendor</th>
          <th class="px-5 py-3">Category</th>
          <th class="px-5 py-3 text-right">Amount</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-fg/10">
        {#each rows as exp (exp.id)}
          <tr class="hover:bg-surface">
            <td class="px-5 py-4 font-mono tabular-nums text-fg/80">{exp.expenseDate}</td>
            <td class="px-5 py-4">
              <a href="/expenses/{exp.id}" class="font-serif text-fg hover:text-accent">
                {exp.merchant}
              </a>
              {#if exp.hasReceipt}
                <span class="ml-2 align-middle text-xs text-fg/40" title="Receipt attached">▣</span>
              {/if}
              {#if exp.needsReview}
                <span
                  class="ml-2 rounded-sm bg-warning/15 px-1.5 py-0.5 align-middle text-[10px] font-medium uppercase tracking-wide text-warning"
                  title="Receipt with no vendor linked"
                >
                  Needs review
                </span>
              {/if}
            </td>
            <td class="px-5 py-4 text-fg/80">{exp.categoryName}</td>
            <td class="px-5 py-4 text-right font-mono tabular-nums text-fg">{exp.amount}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <LoadMore hasMore={cursor !== null} {loading} error={loadError} onclick={more} />
{/if}
