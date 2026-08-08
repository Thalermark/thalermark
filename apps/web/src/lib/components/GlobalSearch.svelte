<script lang="ts">
  import { goto } from '$app/navigation';
  import {
    createGlobalSearch,
    formatMoney,
    groupByType,
    hrefFor,
    isWorthSearching,
  } from '$lib/global-search';
  import type { SearchResult } from '@thalermark/validation';

  // Global search (TMC-198). Collapsed to a magnifier until asked for, which is
  // what lets it sit in the header without spending the nav's deliberate white
  // space (UserMenu's TMC-170 note) — and what removes the need for the app
  // shell's first responsive breakpoint, since an icon is the same width at
  // every viewport.
  //
  // Expanded, the input is absolutely positioned against the header's right
  // edge, so opening it overlays the nav rather than displacing it. Nothing in
  // the header reflows.

  const listboxId = $props.id();

  let open = $state(false);
  let query = $state('');
  let results = $state<SearchResult[]>([]);
  let loading = $state(false);
  let activeIndex = $state(-1);
  let inputEl = $state<HTMLInputElement | null>(null);
  let rootEl = $state<HTMLDivElement | null>(null);

  const search = createGlobalSearch((state) => {
    results = state.results;
    loading = state.loading;
    // Pre-seed the first option so Enter takes the top hit without arrowing —
    // the same affordance the contact picker has.
    activeIndex = state.results.length > 0 ? 0 : -1;
  });

  const groups = $derived(groupByType(results));
  // Flattened, because arrow keys move through the whole list rather than
  // within a section. Index here is the aria-activedescendant index.
  const flat = $derived(groups.flatMap((g) => g.items));
  const searching = $derived(isWorthSearching(query));
  const showMenu = $derived(open && searching);
  // The "see all" row is the last focusable option, so Down from the final
  // result lands on it rather than wrapping straight back to the top.
  const seeAllIndex = $derived(flat.length);
  const optionCount = $derived(flat.length + 1);

  function expand() {
    open = true;
    // Focus after the input exists. Svelte renders it in the same tick the flag
    // flips, so a microtask is enough.
    queueMicrotask(() => inputEl?.focus());
  }

  function collapse() {
    open = false;
    activeIndex = -1;
  }

  function reset() {
    query = '';
    results = [];
    loading = false;
    collapse();
  }

  function go(href: string) {
    reset();
    goto(href);
  }

  function seeAll() {
    const q = query.trim();
    if (q === '') return;
    go(`/search?q=${encodeURIComponent(q)}`);
  }

  function onInput() {
    search.schedule(query);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      // Escape collapses the whole thing rather than just the menu: the box is
      // a transient surface, so "get out of my way" should actually get out.
      reset();
      return;
    }
    if (!showMenu) {
      if (event.key === 'Enter') {
        seeAll();
        event.preventDefault();
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      activeIndex = (activeIndex + 1) % optionCount;
      event.preventDefault();
    } else if (event.key === 'ArrowUp') {
      activeIndex = (activeIndex - 1 + optionCount) % optionCount;
      event.preventDefault();
    } else if (event.key === 'Enter') {
      const hit = flat[activeIndex];
      if (hit) go(hrefFor(hit.entityType, hit.entityId));
      else seeAll();
      event.preventDefault();
    } else if (event.key === 'Tab') {
      collapse();
    }
  }

  function onBlur() {
    // Delay so a click on an option fires before teardown, matching the
    // pickers' 120ms. Only collapses when the box is empty: an accidental click
    // elsewhere must not discard a half-typed query.
    setTimeout(() => {
      if (query.trim() === '') reset();
    }, 120);
  }

  function onDocumentClick(event: MouseEvent) {
    if (!open || !rootEl) return;
    if (!rootEl.contains(event.target as Node)) collapse();
  }

  function onWindowKeydown(event: KeyboardEvent) {
    // Cmd/Ctrl-K from anywhere. It is what everyone reaches for, and it is the
    // reason collapsing costs nothing.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      expand();
    }
  }

  $effect(() => search.destroy);
</script>

<svelte:window onclick={onDocumentClick} onkeydown={onWindowKeydown} />

<div bind:this={rootEl} class="relative flex items-center">
  {#if !open}
    <button
      type="button"
      onclick={(e) => {
        // stopPropagation is load-bearing. expand() swaps this button for the
        // input in the same tick, so by the time the click reaches the window
        // listener below, event.target is detached from the DOM and
        // rootEl.contains(target) is false — the outside-click check would read
        // its own opening click as a click elsewhere and collapse immediately.
        e.stopPropagation();
        expand();
      }}
      class="flex h-8 w-8 items-center justify-center rounded-sm text-fg/60 transition-colors hover:text-fg focus:outline-none focus:ring-2 focus:ring-accent/50"
      aria-label="Search"
      aria-keyshortcuts="Meta+K Control+K"
    >
      <svg
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        class="h-4 w-4"
        aria-hidden="true"
      >
        <circle cx="8.5" cy="8.5" r="5.5" />
        <path d="M12.8 12.8 L17 17" stroke-linecap="round" />
      </svg>
    </button>
  {:else}
    <!-- Absolute so expanding overlays the nav instead of pushing it. -->
    <div class="absolute right-0 top-1/2 z-50 w-[20rem] -translate-y-1/2">
      <input
        bind:this={inputEl}
        bind:value={query}
        oninput={onInput}
        onkeydown={onKeydown}
        onblur={onBlur}
        type="text"
        maxlength="200"
        autocomplete="off"
        placeholder="Search invoices, contacts, expenses…"
        class="field"
        role="combobox"
        aria-expanded={showMenu}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-label="Search"
        aria-activedescendant={showMenu && activeIndex >= 0 ? `gs-opt-${activeIndex}` : undefined}
      />

      {#if showMenu}
        <div
          class="absolute right-0 top-full mt-2 max-h-[26rem] w-full overflow-auto rounded-sm border border-fg/15 bg-surface-2 shadow-lg"
        >
          <ul id={listboxId} role="listbox" aria-label="Search results">
            {#each groups as group (group.type)}
              <li role="group" aria-label={group.label}>
                <p class="label px-3 pt-3 pb-1">{group.label}</p>
                <ul>
                  {#each group.items as hit (hit.entityId)}
                    {@const i = flat.indexOf(hit)}
                    <li
                      id="gs-opt-{i}"
                      role="option"
                      aria-selected={i === activeIndex}
                      class="cursor-pointer px-3 py-2 text-sm text-fg hover:bg-accent/10"
                      class:bg-accent={i === activeIndex}
                      class:text-on-inverse={i === activeIndex}
                      onmousedown={(e) => {
                        e.preventDefault();
                        go(hrefFor(hit.entityType, hit.entityId));
                      }}
                    >
                      <span class="flex items-baseline justify-between gap-3">
                        <span class="truncate">
                          {hit.title}
                          {#if hit.subtitle}
                            <span class="opacity-60">· {hit.subtitle}</span>
                          {/if}
                        </span>
                        {#if hit.amount}
                          <span class="shrink-0 font-mono text-xs opacity-70">
                            {formatMoney(hit.amount)}
                          </span>
                        {/if}
                      </span>
                    </li>
                  {/each}
                </ul>
              </li>
            {/each}

            <li
              id="gs-opt-{seeAllIndex}"
              role="option"
              aria-selected={activeIndex === seeAllIndex}
              class="cursor-pointer border-t border-fg/10 px-3 py-2 text-sm text-fg/70 hover:bg-accent/10"
              class:bg-accent={activeIndex === seeAllIndex}
              class:text-on-inverse={activeIndex === seeAllIndex}
              onmousedown={(e) => {
                e.preventDefault();
                seeAll();
              }}
            >
              {#if flat.length > 0}
                See all results for “{query.trim()}”
              {:else if loading}
                Searching…
              {:else}
                Nothing matched “{query.trim()}” — search everything
              {/if}
            </li>
          </ul>
        </div>

        <!-- Announced rather than rendered as an option, so a screen reader is
             told the count without it becoming something you can arrow onto. -->
        <p class="sr-only" role="status" aria-live="polite">
          {#if loading}
            Searching
          {:else if flat.length === 0}
            No results
          {:else}
            {flat.length} result{flat.length === 1 ? '' : 's'}
          {/if}
        </p>
      {/if}
    </div>
  {/if}
</div>
