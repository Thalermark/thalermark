<script lang="ts">
  import LoadMore from '$lib/components/LoadMore.svelte';
  import { fetchMore } from '$lib/load-more';
  import { may } from '$lib/perms';
  import { untrack } from 'svelte';
  import type { PageProps } from './$types';
  import type { OwnerMoneyRow } from './owner-money-rows';

  let { data }: PageProps = $props();

  const { filters } = $derived(data);
  const companyId = $derived(data.companyId);
  const hasFilters = $derived(!!filters.kind);
  const openingBalance = $derived(data.openingBalance);
  const canWrite = $derived(may(data.role, 'expenses:write'));

  const money = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  // See /contacts for the untrack() seed-and-re-seed pattern. The filter is a
  // GET, so changing it navigates here, re-runs load(), and the $effect re-seeds
  // with the new filter set's page 1.
  let rows = $state<OwnerMoneyRow[]>(untrack(() => data.rows));
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
      const page = await fetchMore<OwnerMoneyRow>('/owner-money/more', cursor, {
        companyId,
        kind: filters.kind,
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
    <span class="eyebrow">Investments &amp; withdrawals</span>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      You and the business<span class="text-accent">.</span>
    </h1>
  </div>
  {#if may(data.role, 'expenses:write')}
    <a href="/owner-money/new" class="btn">+ Record</a>
  {/if}
</div>

<p class="mt-4 max-w-2xl text-sm text-fg/60">
  Money you put into the business from your own pocket, and money you take out to pay yourself.
</p>

<!-- Starting balances — what the business already had when it started. A
     one-time setup; shows a summary once set. -->
{#if canWrite}
  <a
    href="/owner-money/opening-balance"
    class="mt-6 flex items-center justify-between gap-4 rounded-sm border border-fg/10 bg-surface-2 px-5 py-4 hover:border-accent"
  >
    {#if openingBalance}
      <div>
        <span class="label">Starting balances</span>
        <p class="mt-1 font-mono text-sm tabular-nums text-fg/80">
          {money(openingBalance.cash)} in the bank
          {#if Number(openingBalance.receivables) > 0}
            · {money(openingBalance.receivables)} owed to you{/if}
          {#if Number(openingBalance.payables) > 0}
            · {money(openingBalance.payables)} owed{/if}
        </p>
      </div>
      <span class="font-mono text-xs uppercase tracking-widest text-accent">Edit</span>
    {:else}
      <div>
        <span class="label">Starting balances</span>
        <p class="mt-1 text-sm text-fg/60">Tell us what your business started with.</p>
      </div>
      <span class="font-mono text-xs uppercase tracking-widest text-accent">Set →</span>
    {/if}
  </a>
{/if}

<!-- Filter bar. Plain GET form so the filter lives in the URL (shareable, back-
     button friendly) and the page works without JS. -->
<form method="GET" class="mt-8 flex flex-wrap items-end gap-3 rounded-sm border border-fg/10 bg-surface-2 p-4">
  <label class="flex flex-col gap-1 text-xs uppercase tracking-widest text-fg/50">
    Show
    <select
      name="kind"
      onchange={(e) => e.currentTarget.form?.requestSubmit()}
      class="rounded-sm border border-fg/15 bg-surface px-2 py-1.5 text-sm normal-case tracking-normal text-fg"
    >
      <option value="" selected={filters.kind === ''}>All</option>
      <option value="contribution" selected={filters.kind === 'contribution'}>Investments</option>
      <option value="draw" selected={filters.kind === 'draw'}>Withdrawals</option>
    </select>
  </label>
  {#if hasFilters}
    <a href="/owner-money" class="pb-1.5 text-sm text-fg/60 hover:text-fg">Clear</a>
  {/if}
</form>

{#if rows.length === 0}
  <p class="mt-8 text-fg/70">
    {hasFilters ? 'Nothing matches this filter.' : 'Nothing recorded yet.'}
  </p>
{:else}
  <div class="mt-6 overflow-hidden rounded-sm border border-fg/10 bg-surface-2">
    <table class="w-full text-left text-sm">
      <thead class="bg-surface">
        <tr class="label">
          <th class="px-5 py-3">Date</th>
          <th class="px-5 py-3">Type</th>
          <th class="px-5 py-3">Note</th>
          <th class="px-5 py-3 text-right">Amount</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-fg/10">
        {#each rows as ev (ev.id)}
          <tr class="hover:bg-surface">
            <td class="px-5 py-4 font-mono tabular-nums text-fg/80">{ev.occurredOn}</td>
            <td class="px-5 py-4">
              <a href="/owner-money/{ev.id}" class="font-serif text-fg hover:text-accent">
                {ev.kindLabel}
              </a>
            </td>
            <td class="px-5 py-4 text-fg/70">{ev.memo ?? '—'}</td>
            <td
              class="px-5 py-4 text-right font-mono tabular-nums {ev.direction === 'in'
                ? 'text-success'
                : 'text-fg'}"
            >
              {ev.direction === 'in' ? '+' : '−'}{ev.amount}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <LoadMore hasMore={cursor !== null} {loading} error={loadError} onclick={more} />
{/if}
