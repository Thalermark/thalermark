<script lang="ts">
  import { onDestroy } from 'svelte';

  // The Street field, doubling as an address type-ahead over the
  // /locations/autocomplete proxy. Same pattern as ItemPicker: the real field
  // IS the search box, so there's no confusing second input. Typing queries the
  // provider; picking a suggestion writes the cleaned street back into this
  // field and fills the sibling city / region / postalCode / country the parent
  // owns. Progressive enhancement: this renders a real name="addressLine1"
  // input, so with JS off it's just a plain Street field that still submits.
  type Suggestion = {
    label: string;
    addressLine1: string;
    city: string;
    region: string;
    postalCode: string;
    country: string;
  };

  type Props = {
    addressLine1: string;
    city: string;
    region: string;
    postalCode: string;
    country: string;
  };

  let {
    addressLine1 = $bindable(),
    city = $bindable(),
    region = $bindable(),
    postalCode = $bindable(),
    country = $bindable(),
  }: Props = $props();

  let suggestions = $state<Suggestion[]>([]);
  let activeIndex = $state(-1);
  let open = $state(false);
  let loading = $state(false);
  let degraded = $state(false);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let abort: AbortController | null = null;

  // Debounce keeps us under provider rate limits and feels instant (200ms is
  // the sweet spot). Search fires only on real keystrokes (oninput) — NOT on a
  // programmatic pick or an edit-form prefill — so picking a suggestion doesn't
  // immediately reopen the dropdown, and loading an existing customer's address
  // doesn't auto-search on mount.
  const DEBOUNCE_MS = 200;
  const MIN_QUERY = 3;

  function scheduleSearch(q: string) {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (q.trim().length < MIN_QUERY) {
      suggestions = [];
      open = false;
      loading = false;
      return;
    }
    debounceTimer = setTimeout(() => runSearch(q.trim()), DEBOUNCE_MS);
  }

  async function runSearch(q: string) {
    // Cancel any in-flight request — stale results landing after a newer
    // query is the classic dropdown bug.
    abort?.abort();
    abort = new AbortController();
    loading = true;
    try {
      const params = new URLSearchParams({ q });
      // Bias to country if the parent already has one; cheap quality win.
      const c = country?.trim().toUpperCase();
      if (c && c.length === 2) params.set('country', c);
      const res = await fetch(`/locations/autocomplete?${params}`, { signal: abort.signal });
      if (!res.ok) {
        suggestions = [];
        open = false;
        return;
      }
      const body = (await res.json()) as { suggestions: Suggestion[]; degraded?: boolean };
      suggestions = body.suggestions;
      degraded = body.degraded === true;
      open = true;
      activeIndex = suggestions.length > 0 ? 0 : -1;
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      suggestions = [];
      open = false;
    } finally {
      loading = false;
    }
  }

  function pick(s: Suggestion) {
    // Picking rewrites the Street field to the cleaned street line and fans the
    // rest out to the sibling fields (no search re-triggers: this is a
    // programmatic assignment, not an oninput).
    addressLine1 = s.addressLine1;
    city = s.city;
    region = s.region;
    postalCode = s.postalCode;
    country = s.country;
    suggestions = [];
    open = false;
    activeIndex = -1;
  }

  function onKeydown(event: KeyboardEvent) {
    if (!open || suggestions.length === 0) {
      // ArrowDown on a closed list re-opens if we have stale suggestions.
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
      // Enter picks the active suggestion instead of submitting the form.
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
    // Delay so a click on the listbox option fires before we tear down.
    setTimeout(() => {
      open = false;
    }, 120);
  }

  onDestroy(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    abort?.abort();
  });
</script>

<div class="relative">
  <label for="addressLine1" class="font-mono text-xs uppercase tracking-widest text-ink/50">
    Street
  </label>
  <input
    id="addressLine1"
    name="addressLine1"
    type="text"
    maxlength="200"
    autocomplete="off"
    placeholder="House number + street, and city or ZIP"
    bind:value={addressLine1}
    oninput={(e) => scheduleSearch(e.currentTarget.value)}
    onkeydown={onKeydown}
    onblur={onBlur}
    onfocus={() => {
      if (suggestions.length > 0) open = true;
    }}
    role="combobox"
    aria-expanded={open}
    aria-controls="address-lookup-listbox"
    aria-activedescendant={activeIndex >= 0 ? `address-lookup-option-${activeIndex}` : undefined}
    aria-autocomplete="list"
    class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
  />
  {#if loading}
    <span class="absolute right-3 top-[2.1rem] text-xs text-ink/50">…</span>
  {/if}
  {#if open && suggestions.length > 0}
    <ul
      id="address-lookup-listbox"
      role="listbox"
      class="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-sm border border-ink/15 bg-cream-warm shadow-lg"
    >
      {#each suggestions as s, i (i)}
        <li
          id="address-lookup-option-{i}"
          role="option"
          aria-selected={i === activeIndex}
          class="cursor-pointer px-3 py-2 text-sm text-ink hover:bg-gold-deep/10"
          class:bg-gold-deep={i === activeIndex}
          class:text-cream={i === activeIndex}
          onmousedown={(e) => {
            e.preventDefault();
            pick(s);
          }}
        >
          {s.label}
        </li>
      {/each}
    </ul>
  {/if}
  {#if degraded}
    <p class="mt-1 text-xs text-oxblood/70">
      Address lookup is temporarily unavailable; type the address by hand.
    </p>
  {/if}
  <p class="mt-1 text-xs text-ink/40">
    Type the address (include the city or ZIP) and pick a suggestion — the fields below fill in.
  </p>
</div>
