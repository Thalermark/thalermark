<script lang="ts">
  import LoadMore from '$lib/components/LoadMore.svelte';
  import { fetchMore } from '$lib/load-more';
  import { may } from '$lib/perms';
  import { untrack } from 'svelte';
  import type { PageProps } from './$types';
  import type { OwnerMoneyRow } from './owner-money-rows';

  let { data, form }: PageProps = $props();

  const { filters } = $derived(data);
  const companyId = $derived(data.companyId);
  const hasFilters = $derived(!!filters.kind);
  const canWrite = $derived(may(data.role, 'expenses:write'));
  const showDeleted = $derived(data.showDeleted);

  // The toggle keeps the kind filter, so the user stays where they were.
  const toggleHref = $derived.by(() => {
    const params = new URLSearchParams(filters.kind ? { kind: filters.kind } : {});
    if (!showDeleted) params.set('deleted', '1');
    const qs = params.toString();
    return qs ? `/owner-money?${qs}` : '/owner-money';
  });

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

  // Gated on there being something to restore, not merely on the view being
  // open. A table column reserves its width whether or not any cell in it has
  // content, so an unconditional action column made every row jump sideways on
  // a toggle that had found nothing.
  const showRestore = $derived(showDeleted && canWrite && rows.some((r) => r.deleted));

  async function more() {
    if (loading || cursor === null) return;
    loading = true;
    loadError = false;
    try {
      const page = await fetchMore<OwnerMoneyRow>('/owner-money/more', cursor, {
        companyId,
        kind: filters.kind,
        deleted: showDeleted ? '1' : '',
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

<!-- Starting balances used to be a card here. They're setup, not a transaction,
     so they moved to Settings alongside the other ways data gets in. A signpost
     stays because someone thinking about money between them and the business is
     plausibly thinking about where the books started. -->
<p class="mt-2 text-sm text-fg/50">
  Just getting set up? <a href="/settings/import" class="link">Starting balances</a> live in
  Settings, with everything else about bringing your data across.
</p>

<!-- Filter bar. Plain GET form so the filter lives in the URL (shareable, back-
     button friendly) and the page works without JS. -->
<form method="GET" class="mt-8 flex flex-wrap items-end gap-3 rounded-sm border border-fg/10 bg-surface-2 p-4">
  <!-- Carried through the GET so changing the filter from the show-deleted view
       doesn't silently drop the user back into the live list. -->
  {#if showDeleted}
    <input type="hidden" name="deleted" value="1" />
  {/if}
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

<div class="mt-6">
  <a href={toggleHref} class="label hover:text-accent">
    {showDeleted ? '← Hide deleted' : 'Show deleted'}
  </a>
</div>

{#if form?.restoreError}
  <div class="mt-4 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    Could not restore that record: {form.restoreError}
  </div>
{/if}

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
          {#if showRestore}
            <th class="px-5 py-3"><span class="sr-only">Restore</span></th>
          {/if}
        </tr>
      </thead>
      <tbody class="divide-y divide-fg/10">
        {#each rows as ev (ev.id)}
          <tr class="hover:bg-surface">
            <td class="px-5 py-4 font-mono tabular-nums text-fg/80">{ev.occurredOn}</td>
            <td class="px-5 py-4">
              <!-- A deleted row has no page to link to — the detail route 404s
                   while deleted_at is set — so its label is plain text. -->
              {#if ev.deleted}
                <span class="font-serif text-fg/60">{ev.kindLabel}</span>
                <span
                  class="ml-2 rounded-sm border border-fg/15 px-1.5 py-0.5 align-middle font-mono text-[10px] uppercase tracking-widest text-fg/50"
                >
                  Deleted
                </span>
              {:else}
                <a href="/owner-money/{ev.id}" class="font-serif text-fg hover:text-accent">
                  {ev.kindLabel}
                </a>
              {/if}
            </td>
            <td class="px-5 py-4 text-fg/70">{ev.memo ?? '—'}</td>
            <td
              class="px-5 py-4 text-right font-mono tabular-nums {ev.direction === 'in'
                ? 'text-success'
                : 'text-fg'}"
            >
              {ev.direction === 'in' ? '+' : '−'}{ev.amount}
            </td>
            {#if showRestore}
              <td class="px-5 py-4 text-right">
                {#if ev.deleted}
                  <form method="post" action="?/restore">
                    <input type="hidden" name="id" value={ev.id} />
                    <button
                      type="submit"
                      class="rounded-sm border border-fg/15 px-2 py-1 font-mono text-xs uppercase tracking-widest text-fg/60 transition-colors hover:border-accent hover:text-accent"
                    >
                      Restore
                    </button>
                  </form>
                {/if}
              </td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <LoadMore hasMore={cursor !== null} {loading} error={loadError} onclick={more} />
{/if}
