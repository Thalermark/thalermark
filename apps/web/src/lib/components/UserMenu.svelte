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
    class="flex items-center gap-2 rounded-full focus:outline-none focus:ring-2 focus:ring-primary-300"
  >
    <AvatarBubble {name} {email} />
  </button>
  {#if open}
    <div
      role="menu"
      class="absolute right-0 z-10 mt-2 w-56 rounded-md border border-primary-200 bg-white py-1 shadow-lg"
    >
      <div class="px-3 py-2 text-xs text-primary-500">
        <div class="truncate font-medium text-primary-900">{name || email}</div>
        {#if name}
          <div class="truncate">{email}</div>
        {/if}
      </div>
      <div class="my-1 border-t border-primary-100"></div>
      <a
        href="/select-company"
        role="menuitem"
        onclick={close}
        class="block px-3 py-2 text-sm text-primary-700 hover:bg-primary-50"
      >
        {COPY.account}
      </a>
      <button
        type="button"
        role="menuitem"
        onclick={onSignOut}
        class="block w-full px-3 py-2 text-left text-sm text-primary-700 hover:bg-primary-50"
      >
        {COPY.signOut}
      </button>
    </div>
  {/if}
</div>
