<script lang="ts">
  import { authClient } from '$lib/auth-client';
  import { COPY } from '@thalermark/brand';
  import AvatarBubble from './AvatarBubble.svelte';
  import ThemeToggle from './ThemeToggle.svelte';

  type Company = { id: string; name: string };
  type Props = {
    name: string;
    email: string;
    companies?: Company[];
    activeCompanyId?: string | null;
    canManageCompanies?: boolean;
    currentPath?: string;
  };

  let {
    name,
    email,
    companies = [],
    activeCompanyId = null,
    canManageCompanies = false,
    currentPath = '/',
  }: Props = $props();
  let open = $state(false);
  let root: HTMLDivElement | undefined = $state();

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
        {#each companies as c (c.id)}
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
        href="/items"
        role="menuitem"
        onclick={close}
        class="block px-4 py-2 text-sm text-fg/80 transition-colors hover:bg-surface-2 hover:text-fg"
      >
        Items
      </a>
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
