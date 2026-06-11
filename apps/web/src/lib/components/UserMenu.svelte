<script lang="ts">
  import { authClient } from '$lib/auth-client';
  import { COPY } from '@thalermark/brand';
  import AvatarBubble from './AvatarBubble.svelte';

  type Props = {
    name: string;
    email: string;
  };

  let { name, email }: Props = $props();
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
    class="flex items-center gap-2 rounded-full focus:outline-none focus:ring-2 focus:ring-gold/50"
  >
    <AvatarBubble {name} {email} />
  </button>
  {#if open}
    <div
      role="menu"
      class="absolute right-0 z-10 mt-2 w-60 rounded-sm border border-ink/10 bg-cream py-1 shadow-lg"
    >
      <div class="px-4 py-3">
        <div class="truncate font-serif text-base text-ink">{name || email}</div>
        {#if name}
          <div class="mt-0.5 truncate font-mono text-xs text-ink/60">{email}</div>
        {/if}
      </div>
      <div class="my-1 border-t border-ink/10"></div>
      <a
        href="/select-company"
        role="menuitem"
        onclick={close}
        class="block px-4 py-2 text-sm text-ink/80 transition-colors hover:bg-cream-warm hover:text-ink"
      >
        {COPY.workspace}
      </a>
      <a
        href="/settings"
        role="menuitem"
        onclick={close}
        class="block px-4 py-2 text-sm text-ink/80 transition-colors hover:bg-cream-warm hover:text-ink"
      >
        {COPY.settings}
      </a>
      <button
        type="button"
        role="menuitem"
        onclick={onSignOut}
        class="block w-full px-4 py-2 text-left text-sm text-ink/80 transition-colors hover:bg-cream-warm hover:text-ink"
      >
        {COPY.signOut}
      </button>
    </div>
  {/if}
</div>
