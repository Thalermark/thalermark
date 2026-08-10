<script lang="ts">
  import LoadMore from '$lib/components/LoadMore.svelte';
  import { fetchMore } from '$lib/load-more';
  import { may } from '$lib/perms';
  import { untrack } from 'svelte';
  import type { PageProps } from './$types';
  import type { PurchaseRow } from './purchase-rows';

  let { data, form }: PageProps = $props();

  const companyId = $derived(data.companyId);
  const canWrite = $derived(may(data.role, 'expenses:write'));
  const showDeleted = $derived(data.showDeleted);
  const money = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  let rows = $state<PurchaseRow[]>(untrack(() => data.rows));
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
      const page = await fetchMore<PurchaseRow>('/purchases/more', cursor, {
        companyId,
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
    <span class="eyebrow">Big purchases</span>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      Things you bought<span class="text-accent">.</span>
    </h1>
  </div>
  {#if canWrite}
    <a href="/purchases/new" class="btn">+ Log a purchase</a>
  {/if}
</div>

<p class="mt-4 max-w-2xl text-sm text-fg/60">
  Big things you'll use for years — a mower, trailer, truck. We track what you paid, what you still
  owe, and how it helps at tax time.
</p>

<div class="mt-6">
  <a href={showDeleted ? '/purchases' : '/purchases?deleted=1'} class="label hover:text-accent">
    {showDeleted ? '← Hide deleted' : 'Show deleted'}
  </a>
</div>

{#if form?.restoreError}
  <div class="mt-4 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger" data-form-error role="alert" tabindex="-1">
    Could not restore that purchase: {form.restoreError}
  </div>
{/if}

{#if rows.length === 0}
  <p class="mt-8 text-fg/70">Nothing logged yet.</p>
{:else}
  <div class="mt-6 overflow-hidden rounded-sm border border-fg/10 bg-surface-2">
    <table class="w-full text-left text-sm">
      <thead class="bg-surface">
        <tr class="label">
          <th class="px-5 py-3">Date</th>
          <th class="px-5 py-3">What</th>
          <th class="px-5 py-3 text-right">Cost</th>
          <th class="px-5 py-3 text-right">Still owed</th>
          {#if showRestore}
            <th class="px-5 py-3"><span class="sr-only">Restore</span></th>
          {/if}
        </tr>
      </thead>
      <tbody class="divide-y divide-fg/10">
        {#each rows as p (p.id)}
          <tr class="hover:bg-surface">
            <td class="px-5 py-4 font-mono tabular-nums text-fg/80">{p.purchaseDate}</td>
            <td class="px-5 py-4">
              <!-- A deleted purchase has no page to link to — the detail route
                   404s while deleted_at is set — so its name is plain text. -->
              {#if p.deleted}
                <span class="font-serif text-fg/60">{p.description}</span>
                <span
                  class="ml-2 rounded-sm border border-fg/15 px-1.5 py-0.5 align-middle font-mono text-[10px] uppercase tracking-widest text-fg/50"
                >
                  Deleted
                </span>
              {:else}
                <a href="/purchases/{p.id}" class="font-serif text-fg hover:text-accent">
                  {p.description}
                </a>
              {/if}
              {#if p.vendorName}
                <span class="block text-xs text-fg/50">from {p.vendorName}</span>
              {/if}
            </td>
            <td class="px-5 py-4 text-right font-mono tabular-nums text-fg">{money(p.amount)}</td>
            <td class="px-5 py-4 text-right font-mono tabular-nums">
              {#if p.stillOwes}
                <span class="text-fg">{money(p.owing)}</span>
              {:else}
                <span class="text-fg/40">Paid off</span>
              {/if}
            </td>
            {#if showRestore}
              <td class="px-5 py-4 text-right">
                {#if p.deleted}
                  <form method="post" action="?/restore">
                    <input type="hidden" name="id" value={p.id} />
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
