<script lang="ts">
  import { onDestroy } from 'svelte';

  // The Street field, doubling as an address type-ahead over the two-phase
  // /locations proxies. Same pattern as ItemPicker: the real field IS the search
  // box, so there's no confusing second input. Typing queries
  // /locations/autocomplete for predictions; picking one calls
  // /locations/details to resolve the structured address, writes the cleaned
  // street back into this field, and fills the sibling city / region /
  // postalCode / country the parent owns. A session token minted here threads
  // through the autocomplete calls + the final details call so Google bills one
  // session per address. Progressive enhancement: this renders a real
  // name="addressLine1" input, so with JS off it's just a plain Street field
  // that still submits.
  type Prediction = { placeId: string; label: string };
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

  let predictions = $state<Prediction[]>([]);
  let activeIndex = $state(-1);
  let open = $state(false);
  let loading = $state(false);
  let degraded = $state(false);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let abort: AbortController | null = null;
  // Minted lazily on the first keystroke of a lookup, reused across the
  // per-keystroke autocomplete calls, then cleared on pick so the next address
  // starts a fresh billing session.
  let sessionToken: string | null = null;

  function ensureSession(): string {
    if (!sessionToken) sessionToken = crypto.randomUUID();
    return sessionToken;
  }

  // Debounce keeps us under provider rate limits and feels instant (200ms is
  // the sweet spot). Search fires only on real keystrokes (oninput) — NOT on a
  // programmatic pick or an edit-form prefill — so picking a suggestion doesn't
  // immediately reopen the dropdown, and loading an existing contact's address
  // doesn't auto-search on mount.
  const DEBOUNCE_MS = 200;
  const MIN_QUERY = 3;

  function scheduleSearch(q: string) {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (q.trim().length < MIN_QUERY) {
      predictions = [];
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
      const params = new URLSearchParams({ q, sessionToken: ensureSession() });
      // Bias to country if the parent already has one; cheap quality win.
      const c = country?.trim().toUpperCase();
      if (c && c.length === 2) params.set('country', c);
      const res = await fetch(`/locations/autocomplete?${params}`, { signal: abort.signal });
      if (!res.ok) {
        predictions = [];
        open = false;
        return;
      }
      const body = (await res.json()) as { predictions: Prediction[]; degraded?: boolean };
      predictions = body.predictions;
      degraded = body.degraded === true;
      open = true;
      activeIndex = predictions.length > 0 ? 0 : -1;
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      predictions = [];
      open = false;
    } finally {
      loading = false;
    }
  }

  async function pick(p: Prediction) {
    // Picking closes the dropdown, then resolves the structured address via the
    // details proxy. We reuse (and then retire) the session token so Google
    // bills the whole interaction as one session.
    open = false;
    activeIndex = -1;
    predictions = [];
    const token = sessionToken ?? undefined;
    sessionToken = null;
    loading = true;
    try {
      const params = new URLSearchParams({ placeId: p.placeId });
      if (token) params.set('sessionToken', token);
      const res = await fetch(`/locations/details?${params}`);
      if (!res.ok) {
        degraded = true;
        return;
      }
      const body = (await res.json()) as { suggestion: Suggestion | null; degraded?: boolean };
      const s = body.suggestion;
      if (!s || body.degraded) {
        // Details failed — leave what the user typed and surface the banner so
        // they can finish by hand.
        degraded = true;
        return;
      }
      // Programmatic assignment (not an oninput), so this doesn't re-trigger a
      // search.
      addressLine1 = s.addressLine1;
      city = s.city;
      region = s.region;
      postalCode = s.postalCode;
      country = s.country;
    } catch {
      degraded = true;
    } finally {
      loading = false;
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (!open || predictions.length === 0) {
      // ArrowDown on a closed list re-opens if we have stale predictions.
      if (event.key === 'ArrowDown' && predictions.length > 0) {
        open = true;
        event.preventDefault();
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      activeIndex = (activeIndex + 1) % predictions.length;
      event.preventDefault();
    } else if (event.key === 'ArrowUp') {
      activeIndex = (activeIndex - 1 + predictions.length) % predictions.length;
      event.preventDefault();
    } else if (event.key === 'Enter') {
      // Enter picks the active prediction instead of submitting the form.
      const p = predictions[activeIndex];
      if (p) {
        pick(p);
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
  <label for="addressLine1" class="label">
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
      if (predictions.length > 0) open = true;
    }}
    role="combobox"
    aria-expanded={open}
    aria-controls="address-lookup-listbox"
    aria-activedescendant={activeIndex >= 0 ? `address-lookup-option-${activeIndex}` : undefined}
    aria-autocomplete="list"
    class="field mt-1"
  />
  {#if loading}
    <span class="absolute right-3 top-[2.1rem] text-xs text-fg/50">…</span>
  {/if}
  {#if open && predictions.length > 0}
    <ul
      id="address-lookup-listbox"
      role="listbox"
      class="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-sm border border-fg/15 bg-surface-2 shadow-lg"
    >
      {#each predictions as p, i (p.placeId)}
        <li
          id="address-lookup-option-{i}"
          role="option"
          aria-selected={i === activeIndex}
          class="cursor-pointer px-3 py-2 text-sm text-fg hover:bg-accent/10"
          class:bg-accent={i === activeIndex}
          class:text-on-inverse={i === activeIndex}
          onmousedown={(e) => {
            e.preventDefault();
            pick(p);
          }}
        >
          {p.label}
        </li>
      {/each}
    </ul>
  {/if}
  {#if degraded}
    <p class="mt-1 text-xs text-danger/70">
      Address lookup is temporarily unavailable; type the address by hand.
    </p>
  {/if}
  <p class="mt-1 text-xs text-fg/40">
    Type the address (include the city or ZIP) and pick a suggestion — the fields below fill in.
  </p>
</div>
