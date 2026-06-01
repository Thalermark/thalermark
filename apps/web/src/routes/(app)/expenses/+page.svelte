<script lang="ts">
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const { filters, pagination } = $derived(data);

  // Build a /expenses URL that keeps the active filters and swaps the page.
  // Used by the prev/next controls so paging doesn't drop the current filter
  // set.
  function pageHref(n: number): string {
    const p = new URLSearchParams();
    if (filters.from) p.set('from', filters.from);
    if (filters.to) p.set('to', filters.to);
    if (filters.category) p.set('category', filters.category);
    if (filters.q) p.set('q', filters.q);
    if (n > 1) p.set('page', String(n));
    const qs = p.toString();
    return qs ? `/expenses?${qs}` : '/expenses';
  }
</script>

<div class="flex items-baseline justify-between gap-6">
  <div>
    <span class="eyebrow">Expenses</span>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-ink">
      All expenses<span class="text-gold-deep">.</span>
    </h1>
  </div>
  <a
    href="/expenses/new"
    class="rounded-sm bg-ink px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
  >
    + New expense
  </a>
</div>

<!-- Filter bar. Plain GET form so filters live in the URL (shareable,
     back-button friendly) and the page works without JS. -->
<form
  method="GET"
  class="mt-8 grid grid-cols-1 gap-3 rounded-sm border border-ink/10 bg-cream-warm p-4 sm:grid-cols-5"
>
  <label class="flex flex-col gap-1 text-xs uppercase tracking-widest text-ink/50">
    From
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
  <label class="flex flex-col gap-1 text-xs uppercase tracking-widest text-ink/50">
    Category
    <select
      name="category"
      class="rounded-sm border border-ink/15 bg-cream px-2 py-1.5 text-sm normal-case tracking-normal text-ink"
    >
      <option value="" selected={filters.category === ''}>All</option>
      {#each data.categories as cat (cat.id)}
        <option value={cat.id} selected={filters.category === cat.id}>{cat.label}</option>
      {/each}
    </select>
  </label>
  <label class="flex flex-col gap-1 text-xs uppercase tracking-widest text-ink/50">
    Merchant
    <input
      type="search"
      name="q"
      value={filters.q}
      placeholder="Search…"
      class="rounded-sm border border-ink/15 bg-cream px-2 py-1.5 text-sm normal-case tracking-normal text-ink"
    />
  </label>
  <div class="flex items-end gap-3">
    <button
      type="submit"
      class="rounded-sm bg-ink px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
    >
      Filter
    </button>
    <a href="/expenses" class="text-sm text-ink/60 hover:text-ink">Clear</a>
  </div>
</form>

{#if data.rows.length === 0}
  <p class="mt-8 text-ink/70">
    {pagination.total === 0 ? 'No expenses yet.' : 'No expenses match these filters.'}
  </p>
{:else}
  <div class="mt-6 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
    <table class="w-full text-left text-sm">
      <thead class="bg-cream">
        <tr class="font-mono text-xs uppercase tracking-widest text-ink/50">
          <th class="px-5 py-3">Date</th>
          <th class="px-5 py-3">Merchant</th>
          <th class="px-5 py-3">Category</th>
          <th class="px-5 py-3 text-right">Amount</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-ink/10">
        {#each data.rows as exp (exp.id)}
          <tr class="hover:bg-cream">
            <td class="px-5 py-4 font-mono tabular-nums text-ink/80">{exp.expenseDate}</td>
            <td class="px-5 py-4">
              <a href="/expenses/{exp.id}" class="font-serif text-ink hover:text-gold-deep">
                {exp.merchant}
              </a>
              {#if exp.hasReceipt}
                <span class="ml-2 align-middle text-xs text-ink/40" title="Receipt attached">▣</span>
              {/if}
            </td>
            <td class="px-5 py-4 text-ink/80">{exp.categoryName}</td>
            <td class="px-5 py-4 text-right font-mono tabular-nums text-ink">{exp.amount}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <div class="mt-4 flex items-center justify-between text-sm text-ink/60">
    <span>
      {pagination.total} expense{pagination.total === 1 ? '' : 's'}
      · page {pagination.page} of {pagination.pageCount}
    </span>
    <div class="flex items-center gap-4">
      {#if pagination.page > 1}
        <a href={pageHref(pagination.page - 1)} class="hover:text-ink">← Prev</a>
      {:else}
        <span class="text-ink/25">← Prev</span>
      {/if}
      {#if pagination.page < pagination.pageCount}
        <a href={pageHref(pagination.page + 1)} class="hover:text-ink">Next →</a>
      {:else}
        <span class="text-ink/25">Next →</span>
      {/if}
    </div>
  </div>
{/if}
