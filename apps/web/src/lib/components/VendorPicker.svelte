<script lang="ts">
  import { VENDOR_NEW, VENDOR_UNCHANGED } from '$lib/expense-vendor';
  import { onDestroy, untrack } from 'svelte';

  // The single on-screen "Vendor" field for an expense. The text input doubles
  // as a type-ahead over the company's contacts (/contacts/search): picking a
  // match links the expense to that contact (the server mirrors its name into
  // the stored merchant), typing free text leaves it unlinked, and an inline
  // "+ Add … as a new vendor" row creates a vendor contact on save. The text
  // posts as `merchant`; a hidden input posts the link state as `vendorContactId`.
  //
  // Progressive enhancement: with JS off this is the same plain text input it
  // replaced — `merchant` still posts and the hidden field stays at its initial
  // value (the server treats the unchanged sentinel as "leave the link alone").
  type Suggestion = { id: string; name: string };

  type Props = {
    // Seeded once at mount (fresh form, ?duplicate / edit load, or extract
    // prefill). Internal state then persists across action re-renders, so a
    // failed save or AI suggestion keeps what the user typed.
    initialMerchant?: string;
    initialVendorContactId?: string;
    required?: boolean;
    // Edit form: an untouched field posts the unchanged sentinel so the API
    // leaves the existing link AND needs-review flag alone. Create form: there
    // is no existing link, so always post the live value (a ?duplicate-seeded
    // vendor must carry through).
    edit?: boolean;
  };

  let {
    initialMerchant = '',
    initialVendorContactId = '',
    required = false,
    edit = false,
  }: Props = $props();

  // Seed once from props (untrack() = capture the initial value, the documented
  // pattern in this app); internal state then persists across action re-renders.
  let merchant = $state(untrack(() => initialMerchant));
  // '' (unlinked) | <uuid> (linked) | VENDOR_NEW (will create). Never the
  // unchanged sentinel — that's derived from `dirty` for the posted value.
  let vendorContactId = $state(untrack(() => initialVendorContactId));
  let dirty = $state(false);

  const listboxId = $props.id();

  let suggestions = $state<Suggestion[]>([]);
  let activeIndex = $state(-1);
  let open = $state(false);
  let inputEl: HTMLInputElement | null = $state(null);
  let menuStyle = $state('');

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let abort: AbortController | null = null;
  const DEBOUNCE_MS = 200;
  const MIN_QUERY = 2;

  // Edit + untouched → unchanged sentinel (server leaves both the link AND the
  // needs-review flag alone). Otherwise the live state.
  const postedVendorId = $derived(edit && !dirty ? VENDOR_UNCHANGED : vendorContactId);
  const linked = $derived(vendorContactId !== '' && vendorContactId !== VENDOR_NEW);
  const willCreate = $derived(vendorContactId === VENDOR_NEW);
  const trimmed = $derived(merchant.trim());

  function positionMenu() {
    if (!inputEl) return;
    const r = inputEl.getBoundingClientRect();
    menuStyle = `top: ${r.bottom + 2}px; left: ${r.left}px; min-width: ${r.width}px;`;
  }

  function scheduleSearch(q: string) {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (q.trim().length < MIN_QUERY) {
      suggestions = [];
      return;
    }
    debounceTimer = setTimeout(() => runSearch(q.trim()), DEBOUNCE_MS);
  }

  async function runSearch(q: string) {
    abort?.abort();
    abort = new AbortController();
    try {
      const res = await fetch(`/contacts/search?q=${encodeURIComponent(q)}`, { signal: abort.signal });
      if (!res.ok) {
        suggestions = [];
        return;
      }
      const body = (await res.json()) as { contacts: Suggestion[] };
      suggestions = body.contacts;
      activeIndex = suggestions.length > 0 ? 0 : -1;
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      suggestions = [];
    }
  }

  // Typing detaches any prior pick — the field is now free text. Programmatic
  // assignment in pick() does not fire oninput, so picking stays linked.
  function onInput() {
    dirty = true;
    vendorContactId = '';
    open = trimmed !== '';
    scheduleSearch(merchant);
  }

  function pick(s: Suggestion) {
    dirty = true;
    merchant = s.name;
    vendorContactId = s.id;
    suggestions = [];
    open = false;
    activeIndex = -1;
  }

  function addNew() {
    dirty = true;
    vendorContactId = VENDOR_NEW;
    open = false;
    activeIndex = -1;
  }

  function onKeydown(event: KeyboardEvent) {
    if (!open || suggestions.length === 0) return;
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
    id="merchant"
    name="merchant"
    type="text"
    {required}
    maxlength="200"
    autocomplete="off"
    bind:value={merchant}
    oninput={onInput}
    onkeydown={onKeydown}
    onblur={onBlur}
    onfocus={() => {
      if (trimmed !== '' && (suggestions.length > 0 || !linked)) open = true;
    }}
    role="combobox"
    aria-expanded={open}
    aria-controls={listboxId}
    aria-autocomplete="list"
    class="field mt-1"
  />
  <input type="hidden" name="vendorContactId" value={postedVendorId} />

  {#if open && trimmed !== ''}
    <ul
      id={listboxId}
      role="listbox"
      style={menuStyle}
      class="fixed z-50 max-h-60 overflow-auto rounded-sm border border-fg/15 bg-surface-2 shadow-lg"
    >
      {#each suggestions as s, i (s.id)}
        <li
          role="option"
          aria-selected={i === activeIndex}
          class="cursor-pointer px-3 py-2 text-sm text-fg hover:bg-accent/10"
          class:bg-accent={i === activeIndex}
          class:text-on-inverse={i === activeIndex}
          onmousedown={(e) => {
            e.preventDefault();
            pick(s);
          }}
        >
          {s.name}
        </li>
      {/each}
      <li
        role="option"
        aria-selected={false}
        class="cursor-pointer border-t border-fg/10 px-3 py-2 text-sm text-accent hover:bg-accent/10"
        onmousedown={(e) => {
          e.preventDefault();
          addNew();
        }}
      >
        + Add “{trimmed}” as a new vendor
      </li>
    </ul>
  {/if}

  {#if linked}
    <p class="mt-1 text-xs text-fg/50">✓ Linked to this vendor.</p>
  {:else if willCreate}
    <p class="mt-1 text-xs text-accent">+ “{trimmed}” will be added as a new vendor on save.</p>
  {/if}
</div>
