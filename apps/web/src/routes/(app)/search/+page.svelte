<script lang="ts">
  import { formatMoney, groupByType, hrefFor } from '$lib/global-search';

  let { data } = $props();

  const groups = $derived(groupByType(data.results));
  const total = $derived(data.results.length);

  // Links rather than buttons so paging works with JS off, consistent with the
  // list pages' plain-GET filter forms.
  function pageHref(page: number): string {
    const sp = new URLSearchParams({ q: data.q });
    if (data.scope === 'all') sp.set('scope', 'all');
    if (page > 1) sp.set('page', String(page));
    return `/search?${sp}`;
  }

  function scopeHref(scope: 'company' | 'all'): string {
    const sp = new URLSearchParams({ q: data.q });
    if (scope === 'all') sp.set('scope', 'all');
    return `/search?${sp}`;
  }
</script>

<svelte:head><title>Search · Thalermark</title></svelte:head>

<h1 class="font-serif text-4xl font-light text-fg">Search</h1>

<!-- Plain GET form: works with JS disabled, and keeps the query in the URL so a
     result set is linkable. -->
<form method="GET" action="/search" class="mt-6 flex items-center gap-3">
  <input
    type="text"
    name="q"
    value={data.q}
    maxlength="200"
    autocomplete="off"
    placeholder="Search invoices, estimates, contacts, expenses, bills, jobs, items…"
    class="field flex-1"
    aria-label="Search"
  />
  {#if data.scope === 'all'}
    <input type="hidden" name="scope" value="all" />
  {/if}
  <button type="submit" class="btn">Search</button>
</form>

{#if data.q !== ''}
  <div class="mt-4 flex items-center gap-4 font-mono text-xs uppercase tracking-widest">
    <a
      href={scopeHref('company')}
      class="hover:text-fg {data.scope === 'company' ? 'text-fg' : 'text-fg/50'}"
    >
      This business
    </a>
    <a
      href={scopeHref('all')}
      class="hover:text-fg {data.scope === 'all' ? 'text-fg' : 'text-fg/50'}"
    >
      All businesses
    </a>
  </div>
{/if}

{#if data.q === ''}
  <p class="mt-10 text-sm text-fg/60">
    Type anything — a customer's name, an invoice number, an amount, a note on a receipt.
  </p>
{:else if total === 0}
  <div class="callout mt-10">
    <p class="text-sm text-fg/80">
      <span class="text-fg">Nothing matched “{data.q}”.</span>
      Search covers invoices, estimates, contacts, expenses, bills, jobs and items — names,
      numbers, amounts and notes. Try a shorter word, or check you're looking in the right
      business.
    </p>
  </div>
{:else}
  <p class="mt-8 font-mono text-xs uppercase tracking-widest text-fg/50" role="status">
    {total} result{total === 1 ? '' : 's'}{data.page > 1 ? ` · page ${data.page}` : ''}
  </p>

  {#each groups as group (group.type)}
    <section class="mt-8">
      <h2 class="label">{group.label}</h2>
      <ul class="mt-2 divide-y divide-fg/10 border-y border-fg/10">
        {#each group.items as hit (hit.entityId)}
          <li>
            <a
              href={hrefFor(hit.entityType, hit.entityId)}
              class="flex items-baseline justify-between gap-4 px-1 py-3 hover:bg-accent/5"
            >
              <span class="min-w-0">
                <span class="text-fg">{hit.title}</span>
                {#if hit.subtitle}
                  <span class="text-fg/50"> · {hit.subtitle}</span>
                {/if}
                {#if hit.status}
                  <span class="ml-2 font-mono text-xs uppercase tracking-widest text-fg/40">
                    {hit.status}
                  </span>
                {/if}
              </span>
              <span class="shrink-0 text-right">
                {#if hit.amount}
                  <span class="font-mono text-sm text-fg/80">{formatMoney(hit.amount)}</span>
                {/if}
                {#if hit.occurredOn}
                  <span class="ml-3 font-mono text-xs text-fg/40">{hit.occurredOn}</span>
                {/if}
              </span>
            </a>
          </li>
        {/each}
      </ul>
    </section>
  {/each}

  <nav class="mt-10 flex items-center justify-between" aria-label="Search result pages">
    {#if data.page > 1}
      <a href={pageHref(data.page - 1)} class="btn-ghost btn">Previous</a>
    {:else}
      <span></span>
    {/if}
    {#if data.hasMore && !data.atDepthLimit}
      <a href={pageHref(data.page + 1)} class="btn-ghost btn">Next</a>
    {/if}
  </nav>

  {#if data.atDepthLimit}
    <!-- Ranked results are a top-N, not a browsable list. Rather than paging
         forever through a fading tail, point at the tools built for it. -->
    <div class="callout mt-6">
      <p class="text-sm text-fg/80">
        <span class="text-fg">That's as far as search goes.</span>
        If what you're after is further down, the Invoices, Expenses and Contacts pages have
        filters and date ranges built for working through a long list.
      </p>
    </div>
  {/if}
{/if}
