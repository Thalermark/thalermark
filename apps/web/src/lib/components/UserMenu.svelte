<script lang="ts">
  import { authClient } from '$lib/auth-client';
  import { COPY } from '@thalermark/brand';
  import AvatarBubble from './AvatarBubble.svelte';
  import ThemeToggle from './ThemeToggle.svelte';

  type Company = { id: string; name: string; retiredAt?: string | null };
  type Props = {
    name: string;
    email: string;
    companies?: Company[];
    activeCompanyId?: string | null;
    canManageCompanies?: boolean;
    // "The Ledger" (manual journal adjustments) — gated to owner/admin/
    // accountant. It lives here in the menu, not the primary nav: the deliberate
    // accounting back room, reached on purpose.
    canAdjustLedger?: boolean;
    currentPath?: string;
  };

  let {
    name,
    email,
    companies = [],
    activeCompanyId = null,
    canManageCompanies = false,
    canAdjustLedger = false,
    currentPath = '/',
  }: Props = $props();
  let open = $state(false);
  let root: HTMLDivElement | undefined = $state();

  // Businesses that have stopped trading are split out rather than dropped. They
  // stay switchable — their books have to stay readable for years — but someone
  // running one business shouldn't scroll past every business they ever closed.
  // The active company is always shown, even when retired, so the menu never
  // disagrees with the company whose figures are on screen.
  const activeCompanies = $derived(companies.filter((c) => !c.retiredAt));
  const retiredCompanies = $derived(
    companies.filter((c) => c.retiredAt && c.id !== activeCompanyId),
  );
  const activeIsRetired = $derived(
    companies.some((c) => c.id === activeCompanyId && c.retiredAt != null),
  );
  let showRetired = $state(false);

  function toggle() {
    open = !open;
  }

  function close() {
    open = false;
  }

  function onDocumentClick(event: MouseEvent) {
    if (!open || !root) return;
    if (!root.contains(event.target as Node)) close();
  }

  function onKey(event: KeyboardEvent) {
    if (open && event.key === 'Escape') close();
  }

  async function onSignOut() {
    close();
    await authClient.signOut();
    // Hard nav: clears all client-side state along with the BA cookie.
    window.location.assign('/sign-in');
  }
</script>

<svelte:window onclick={onDocumentClick} onkeydown={onKey} />

<div bind:this={root} class="relative">
  <button
    type="button"
    onclick={toggle}
    aria-haspopup="menu"
    aria-expanded={open}
    class="flex items-center gap-2 rounded-full focus:outline-none focus:ring-2 focus:ring-accent/50"
  >
    <AvatarBubble {name} {email} />
  </button>
  {#if open}
    <div
      role="menu"
      class="absolute right-0 z-10 mt-2 w-60 rounded-sm border border-fg/10 bg-surface py-1 shadow-lg"
    >
      <div class="px-4 py-3">
        <div class="truncate font-serif text-base text-fg">{name || email}</div>
        {#if name}
          <div class="mt-0.5 truncate font-mono text-xs text-fg/60">{email}</div>
        {/if}
      </div>
      <div class="my-1 border-t border-fg/10"></div>
      {#if companies.length > 0}
        <p class="px-4 pb-1 pt-2 font-mono text-[10px] uppercase tracking-widest text-fg/40">
          Company
        </p>
        {#each activeCompanies as c (c.id)}
          {#if c.id === activeCompanyId}
            <div class="flex items-center gap-2 px-4 py-2 text-sm text-fg">
              <span class="text-accent">✓</span>
              <span class="truncate">{c.name}</span>
            </div>
          {:else}
            <form method="POST" action="/companies/switch">
              <input type="hidden" name="companyId" value={c.id} />
              <input type="hidden" name="returnTo" value={currentPath} />
              <button
                type="submit"
                role="menuitem"
                class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-fg/80 transition-colors hover:bg-surface-2 hover:text-fg"
              >
                <span class="w-3"></span>
                <span class="truncate">{c.name}</span>
              </button>
            </form>
          {/if}
        {/each}
        <!-- A retired company that's currently selected is pinned here regardless
             of the toggle: the menu must never disagree with whose figures are
             on screen. -->
        {#if activeIsRetired}
          <div class="flex items-center gap-2 px-4 py-2 text-sm text-fg">
            <span class="text-accent">✓</span>
            <span class="truncate">{companies.find((c) => c.id === activeCompanyId)?.name}</span>
            <span class="font-mono text-[10px] uppercase tracking-widest text-fg/40">Closed</span>
          </div>
        {/if}
        {#if retiredCompanies.length > 0}
          {#if showRetired}
            {#each retiredCompanies as c (c.id)}
              <form method="POST" action="/companies/switch">
                <input type="hidden" name="companyId" value={c.id} />
                <input type="hidden" name="returnTo" value={currentPath} />
                <button
                  type="submit"
                  role="menuitem"
                  class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-fg/60 transition-colors hover:bg-surface-2 hover:text-fg"
                >
                  <span class="w-3"></span>
                  <span class="truncate">{c.name}</span>
                  <span class="font-mono text-[10px] uppercase tracking-widest text-fg/40">
                    Closed
                  </span>
                </button>
              </form>
            {/each}
          {/if}
          <button
            type="button"
            class="block w-full px-4 py-2 text-left text-xs text-fg/50 transition-colors hover:bg-surface-2 hover:text-fg/70"
            onclick={() => (showRetired = !showRetired)}
          >
            {showRetired ? 'Hide' : 'Show'} closed ({retiredCompanies.length})
          </button>
        {/if}
        {#if canManageCompanies}
          <a
            href="/companies/new"
            role="menuitem"
            onclick={close}
            class="block px-4 py-2 text-sm text-accent transition-colors hover:bg-surface-2"
          >
            + Add company
          </a>
        {/if}
        <div class="my-1 border-t border-fg/10"></div>
      {/if}
      <a
        href="/select-company"
        role="menuitem"
        onclick={close}
        class="block px-4 py-2 text-sm text-fg/80 transition-colors hover:bg-surface-2 hover:text-fg"
      >
        {COPY.workspace}
      </a>
      <a
        href="/bills"
        role="menuitem"
        onclick={close}
        class="block px-4 py-2 text-sm text-fg/80 transition-colors hover:bg-surface-2 hover:text-fg"
      >
        Bills
      </a>
      <a
        href="/owner-money"
        role="menuitem"
        onclick={close}
        class="block px-4 py-2 text-sm text-fg/80 transition-colors hover:bg-surface-2 hover:text-fg"
      >
        Investments &amp; withdrawals
      </a>
      <a
        href="/items"
        role="menuitem"
        onclick={close}
        class="block px-4 py-2 text-sm text-fg/80 transition-colors hover:bg-surface-2 hover:text-fg"
      >
        Items
      </a>
      <!--
        Appended rather than slotted by perceived usage: this group's order is
        deliberate (TMC-170) and reordering it is the owner's call, not a
        side-effect of adding a surface. The top nav stays at five — the freed
        slot there is white space on purpose.
      -->
      <a
        href="/jobs"
        role="menuitem"
        onclick={close}
        class="block px-4 py-2 text-sm text-fg/80 transition-colors hover:bg-surface-2 hover:text-fg"
      >
        Jobs
      </a>
      {#if canAdjustLedger}
        <a
          href="/ledger"
          role="menuitem"
          onclick={close}
          class="block px-4 py-2 text-sm text-fg/80 transition-colors hover:bg-surface-2 hover:text-fg"
        >
          Ledger
        </a>
      {/if}
      <a
        href="/settings"
        role="menuitem"
        onclick={close}
        class="block px-4 py-2 text-sm text-fg/80 transition-colors hover:bg-surface-2 hover:text-fg"
      >
        {COPY.settings}
      </a>
      <div class="my-1 border-t border-fg/10"></div>
      <ThemeToggle />
      <div class="my-1 border-t border-fg/10"></div>
      <button
        type="button"
        role="menuitem"
        onclick={onSignOut}
        class="block w-full px-4 py-2 text-left text-sm text-fg/80 transition-colors hover:bg-surface-2 hover:text-fg"
      >
        {COPY.signOut}
      </button>
    </div>
  {/if}
</div>
