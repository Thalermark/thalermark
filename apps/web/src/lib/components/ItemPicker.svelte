<script lang="ts">
  import { onDestroy } from 'svelte';

  // Type-ahead over the per-company items catalog, wired into the description
  // cell of every line-item form (invoice / estimate / recurring). The
  // description input doubles as the search box: typing queries /items/search
  // (ILIKE on item name); picking a match prefills description / unit price /
  // quantity and stamps the source_item_id breadcrumb. A hand-typed line
  // leaves source_item_id empty.
  //
  // Progressive enhancement: with JS off, this renders as the same plain
  // description input it replaced — the form still posts li_description /
  // li_sourceItemId by name, and the server recomputes money authoritatively.
  type Suggestion = {
    id: string;
    name: string;
    description: string | null;
    unitPrice: string;
    unitLabel: string | null;
    defaultQuantity: string;
  };

  type Props = {
    description: string;
    quantity: string;
    unitPrice: string;
    sourceItemId: string | null;
  };

  let {
    description = $bindable(),
    quantity = $bindable(),
    unitPrice = $bindable(),
    sourceItemId = $bindable(),
  }: Props = $props();

  // Unique, hydration-stable id so each row's combobox points aria-controls
  // at its own listbox (multiple ItemPickers render per line-item table).
  const listboxId = $props.id();

  let suggestions = $state<Suggestion[]>([]);
  let activeIndex = $state(-1);
  let open = $state(false);

  // The line-item table wraps rows in an overflow-hidden container (for its
  // rounded corners), which would clip an absolutely-positioned dropdown. So
  // the menu is position:fixed, anchored to the input's viewport rect — it
  // escapes every ancestor's overflow / stacking context. Recomputed whenever
  // it opens and on scroll/resize while open.
  let inputEl: HTMLInputElement | null = $state(null);
  let menuStyle = $state('');

  function positionMenu() {
    if (!inputEl) return;
    const r = inputEl.getBoundingClientRect();
    menuStyle = `top: ${r.bottom + 2}px; left: ${r.left}px; min-width: ${r.width}px;`;
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let abort: AbortController | null = null;

  const DEBOUNCE_MS = 200;
  const MIN_QUERY = 2;

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  // Strip numeric(15,4) trailing zeros so "1.0000" prefills as "1".
  const cleanQty = (s: string) => String(Number(s));

  function scheduleSearch(q: string) {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (q.trim().length < MIN_QUERY) {
      suggestions = [];
      open = false;
      return;
    }
    debounceTimer = setTimeout(() => runSearch(q.trim()), DEBOUNCE_MS);
  }

  async function runSearch(q: string) {
    abort?.abort();
    abort = new AbortController();
    try {
      const res = await fetch(`/items/search?q=${encodeURIComponent(q)}`, { signal: abort.signal });
      if (!res.ok) {
        suggestions = [];
        open = false;
        return;
      }
      const body = (await res.json()) as { items: Suggestion[] };
      suggestions = body.items;
      open = suggestions.length > 0;
      activeIndex = suggestions.length > 0 ? 0 : -1;
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      suggestions = [];
      open = false;
    }
  }

  // User typing detaches any prior pick — the line is now free text, so the
  // breadcrumb must clear or the report would misattribute it. Programmatic
  // assignment in pick() does not fire oninput, so picking is safe.
  function onInput() {
    sourceItemId = null;
    scheduleSearch(description);
  }

  function pick(s: Suggestion) {
    description = s.description?.trim() || s.name;
    unitPrice = s.unitPrice;
    quantity = cleanQty(s.defaultQuantity);
    sourceItemId = s.id;
    suggestions = [];
    open = false;
    activeIndex = -1;
  }

  function onKeydown(event: KeyboardEvent) {
    if (!open || suggestions.length === 0) {
      if (event.key === 'ArrowDown' && suggestions.length > 0) {
        open = true;
        event.preventDefault();
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      activeIndex = (activeIndex + 1) % suggestions.length;
      event.preventDefault();
    } else if (event.key === 'ArrowUp') {
      activeIndex = (activeIndex - 1 + suggestions.length) % suggestions.length;
      event.preventDefault();
    } else if (event.key === 'Enter') {
      const s = suggestions[activeIndex];
      if (s) {
        pick(s);
        event.preventDefault();
      }
    } else if (event.key === 'Escape') {
      open = false;
      activeIndex = -1;
    }
  }

  function onBlur() {
    // Delay so a click on an option fires before we tear down.
    setTimeout(() => {
      open = false;
    }, 120);
  }

  // Keep the fixed menu glued to the input while it's open.
  $effect(() => {
    if (!open) return;
    positionMenu();
    const reposition = () => positionMenu();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  });

  onDestroy(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    abort?.abort();
  });
</script>

<div class="relative">
  <input
    bind:this={inputEl}
    type="text"
    name="li_description"
    required
    maxlength="500"
    autocomplete="off"
    bind:value={description}
    oninput={onInput}
    onkeydown={onKeydown}
    onblur={onBlur}
    onfocus={() => {
      if (suggestions.length > 0) open = true;
    }}
    role="combobox"
    aria-expanded={open}
    aria-controls={listboxId}
    aria-autocomplete="list"
    class="w-full rounded-sm border border-ink/15 bg-cream px-2 py-1 text-ink focus:border-gold-deep focus:outline-none"
  />
  <input type="hidden" name="li_sourceItemId" value={sourceItemId ?? ''} />
  {#if open && suggestions.length > 0}
    <ul
      id={listboxId}
      role="listbox"
      style={menuStyle}
      class="fixed z-50 max-h-60 overflow-auto rounded-sm border border-ink/15 bg-cream-warm shadow-lg"
    >
      {#each suggestions as s, i (s.id)}
        <li
          role="option"
          aria-selected={i === activeIndex}
          class="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm text-ink hover:bg-gold-deep/10"
          class:bg-gold-deep={i === activeIndex}
          class:text-cream={i === activeIndex}
          onmousedown={(e) => {
            e.preventDefault();
            pick(s);
          }}
        >
          <span class="truncate">{s.name}</span>
          <span class="shrink-0 font-mono text-xs tabular-nums opacity-70">
            {fmt(s.unitPrice)}{#if s.unitLabel}/{s.unitLabel}{/if}
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</div>
