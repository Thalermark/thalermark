<script lang="ts">
  import { type DupeCandidate, NEW_CONTACT_SENTINEL, findEmailDupe, findNameDupes } from '$lib/contact-dupes';
  import { type ContactSuggestion, createContactSearch } from '$lib/contact-search';
  import { onDestroy, untrack } from 'svelte';

  // The sell-to "Contact" selector for invoices / estimates / recurring. The
  // text input is a type-ahead over the company's contacts (/contacts/search):
  // picking a match links the document (hidden `contactId` = its UUID), and an
  // inline "+ Add new contact" row swaps in a name + email mini-form (with live
  // dupe hints) that the server creates on submit (hidden `contactId` = the
  // sentinel). Unlike the expense VendorPicker, a free-text-only value is NOT
  // valid here — the document requires a linked contact.
  //
  // JS-first, like ItemPicker: selection needs the search round-trip, so with
  // JS off the field can't pick an id. The server validates `contactId`
  // regardless, so a no-JS submit fails cleanly rather than saving garbage.

  type Props = {
    // Seeded once at mount: an edit load (linked id + name), a ?duplicate, or a
    // fail() re-render (values.contactId + the round-tripped contactName, or a
    // just-created contact on inline-create recovery).
    initialContactId?: string;
    initialContactName?: string;
    initialNewName?: string;
    initialNewEmail?: string;
    // Edit forms select an existing contact only — no inline create, matching
    // the dropdown they replace. New forms allow it.
    allowCreate?: boolean;
    // Server feedback rendered inside the field / inline block.
    fieldError?: string; // contactId
    contactErrors?: Record<string, string>; // name / email / _
    dupeContact?: { id: string; name: string }; // server email hard-block (409)
  };

  let {
    initialContactId = '',
    initialContactName = '',
    initialNewName = '',
    initialNewEmail = '',
    allowCreate = true,
    fieldError,
    contactErrors,
    dupeContact,
  }: Props = $props();

  // contactId: '' (none) | <uuid> (linked) | NEW_CONTACT_SENTINEL (inline
  // create). Seed once from props (untrack = capture the initial value, the
  // documented pattern in this app); state then persists across action
  // re-renders so a failed save keeps the user's pick.
  let contactId = $state(untrack(() => initialContactId));
  // The visible search box; named contactName so the picked/typed text
  // round-trips a fail() re-render. Not rendered (so not posted) in inline mode.
  let query = $state(untrack(() => initialContactName));

  const inlineMode = $derived(contactId === NEW_CONTACT_SENTINEL);
  const linked = $derived(contactId !== '' && contactId !== NEW_CONTACT_SENTINEL);
  const trimmed = $derived(query.trim());

  // --- selection type-ahead ------------------------------------------------
  let suggestions = $state<ContactSuggestion[]>([]);
  let activeIndex = $state(-1);
  let open = $state(false);
  let inputEl: HTMLInputElement | null = $state(null);
  let menuStyle = $state('');
  const listboxId = $props.id();

  const selectSearch = createContactSearch((r) => {
    suggestions = r;
    activeIndex = r.length > 0 ? 0 : -1;
  });

  // The "+ Add new contact" row sits after the suggestions in the keyboard ring.
  const optionCount = $derived(suggestions.length + (allowCreate ? 1 : 0));

  function positionMenu() {
    if (!inputEl) return;
    const r = inputEl.getBoundingClientRect();
    menuStyle = `top: ${r.bottom + 2}px; left: ${r.left}px; min-width: ${r.width}px;`;
  }

  // Typing detaches any prior pick — the field is now an unlinked search.
  // Programmatic assignment in pick() does not fire oninput, so picking stays
  // linked.
  function onInput() {
    contactId = '';
    open = trimmed !== '';
    selectSearch.schedule(query);
  }

  function pick(s: ContactSuggestion) {
    contactId = s.id;
    query = s.name;
    suggestions = [];
    open = false;
    activeIndex = -1;
  }

  function startCreate() {
    contactId = NEW_CONTACT_SENTINEL;
    if (trimmed !== '') newName = trimmed; // carry the typed text into the form
    open = false;
    activeIndex = -1;
  }

  function cancelCreate() {
    contactId = '';
    suggestions = [];
  }

  // Pick a dupe surfaced by the inline hints / server block.
  function useExisting(id: string, name: string) {
    contactId = id;
    query = name;
  }

  function onKeydown(event: KeyboardEvent) {
    if (!open || optionCount === 0) return;
    if (event.key === 'ArrowDown') {
      activeIndex = (activeIndex + 1) % optionCount;
      event.preventDefault();
    } else if (event.key === 'ArrowUp') {
      activeIndex = (activeIndex - 1 + optionCount) % optionCount;
      event.preventDefault();
    } else if (event.key === 'Enter') {
      const s = suggestions[activeIndex];
      if (s) {
        pick(s);
        event.preventDefault();
      } else if (allowCreate && activeIndex === suggestions.length) {
        startCreate();
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

  // --- inline create + live dupe hints -------------------------------------
  let newName = $state(untrack(() => initialNewName));
  let newEmail = $state(untrack(() => initialNewEmail));
  let nameDupeCands = $state<DupeCandidate[]>([]);
  let emailDupeCands = $state<DupeCandidate[]>([]);
  const nameSearch = createContactSearch((r) => (nameDupeCands = r));
  const emailSearch = createContactSearch((r) => (emailDupeCands = r));
  // Filter the on-demand candidates down to true dupes with the shared rules
  // (email exact = hard block; name normalized = soft warn). The server re-runs
  // the email check at submit so the live hint and the block stay in lock-step.
  const liveNameDupes = $derived(findNameDupes(newName, nameDupeCands));
  const liveEmailDupe = $derived(findEmailDupe(newEmail, emailDupeCands));

  function cerr(key: string): string | undefined {
    return contactErrors?.[key];
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
    selectSearch.destroy();
    nameSearch.destroy();
    emailSearch.destroy();
  });
</script>

<input type="hidden" name="contactId" value={contactId} />

{#if !inlineMode}
  <div class="relative">
    <input
      bind:this={inputEl}
      id="contactName"
      name="contactName"
      type="text"
      maxlength="200"
      autocomplete="off"
      placeholder="Search contacts…"
      bind:value={query}
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
            {s.name}{#if s.email}<span class="text-fg/50"> · {s.email}</span>{/if}
          </li>
        {/each}
        {#if allowCreate}
          <li
            role="option"
            aria-selected={activeIndex === suggestions.length}
            class="cursor-pointer border-t border-fg/10 px-3 py-2 text-sm text-accent hover:bg-accent/10"
            class:bg-accent={activeIndex === suggestions.length}
            class:text-on-inverse={activeIndex === suggestions.length}
            onmousedown={(e) => {
              e.preventDefault();
              startCreate();
            }}
          >
            + Add “{trimmed}” as a new contact
          </li>
        {/if}
      </ul>
    {/if}

    {#if linked}
      <p class="mt-1 text-xs text-fg/50">✓ Selected.</p>
    {/if}
    {#if fieldError}
      <p class="mt-1 text-xs text-danger">{fieldError}</p>
    {/if}
  </div>
{:else}
  <div class="mt-1 space-y-3 rounded-sm border border-fg/10 bg-surface-2/60 p-4">
    <div class="flex items-center justify-between">
      <span class="label">New contact</span>
      <button
        type="button"
        onclick={cancelCreate}
        class="text-xs text-fg/60 hover:text-accent"
      >
        ← Pick an existing contact
      </button>
    </div>
    <div>
      <label for="newContactName" class="label">
        Name<span class="text-accent">*</span>
      </label>
      <input
        id="newContactName"
        name="newContactName"
        type="text"
        maxlength="200"
        required
        bind:value={newName}
        oninput={() => nameSearch.schedule(newName)}
        class="field mt-1"
      />
      {#if cerr('name')}
        <p class="mt-1 text-xs text-danger">{cerr('name')}</p>
      {/if}
      {#if liveNameDupes.length > 0}
        <div class="mt-2 rounded-sm border border-fg/10 bg-surface p-2 text-xs">
          <p class="text-fg/60">
            Looks like {liveNameDupes.length === 1 ? 'an existing contact' : 'existing contacts'}:
          </p>
          <ul class="mt-1 space-y-1">
            {#each liveNameDupes as dupe (dupe.id)}
              <li class="flex items-center justify-between gap-2">
                <span class="text-fg">{dupe.name}{#if dupe.email}<span class="text-fg/50"> · {dupe.email}</span>{/if}</span>
                <button
                  type="button"
                  onclick={() => useExisting(dupe.id, dupe.name)}
                  class="rounded-sm border border-fg/15 bg-surface-2 px-2 py-1 text-xs uppercase tracking-wider text-fg/70 hover:border-accent hover:text-accent"
                >
                  Use
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>
    <div>
      <label for="newContactEmail" class="label">Email</label>
      <input
        id="newContactEmail"
        name="newContactEmail"
        type="email"
        maxlength="320"
        bind:value={newEmail}
        oninput={() => emailSearch.schedule(newEmail)}
        class="field mt-1"
      />
      {#if cerr('email') && cerr('email') !== 'email_dupe'}
        <p class="mt-1 text-xs text-danger">{cerr('email')}</p>
      {/if}
      <p class="mt-1 text-xs text-fg/50">Optional, but needed to send by email.</p>
    </div>
    {#if dupeContact}
      <div class="rounded-sm border border-danger/30 bg-danger/5 p-3 text-sm">
        <p class="text-fg">
          <span class="font-medium">{dupeContact.name}</span> already uses this email.
        </p>
        <div class="mt-2 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onclick={() => useExisting(dupeContact!.id, dupeContact!.name)}
            class="rounded-sm bg-inverse px-3 py-1 text-xs uppercase tracking-wider text-on-inverse hover:bg-accent"
          >
            Use {dupeContact.name}
          </button>
          <span class="text-xs text-fg/50">or change the email above to create a different contact.</span>
        </div>
      </div>
    {:else if liveEmailDupe}
      <div class="rounded-sm border border-accent/30 bg-accent/5 p-3 text-sm">
        <p class="text-fg">
          <span class="font-medium">{liveEmailDupe.name}</span> already uses this email.
        </p>
        <button
          type="button"
          onclick={() => useExisting(liveEmailDupe!.id, liveEmailDupe!.name)}
          class="mt-2 rounded-sm border border-fg/20 bg-surface-2 px-3 py-1 text-xs uppercase tracking-wider text-fg/70 hover:border-accent hover:text-accent"
        >
          Use {liveEmailDupe.name}
        </button>
      </div>
    {/if}
    {#if cerr('_')}
      <p class="text-xs text-danger">{cerr('_')}</p>
    {/if}
    {#if fieldError}
      <p class="text-xs text-danger">{fieldError}</p>
    {/if}
  </div>
{/if}
