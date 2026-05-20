<script lang="ts">
  import { page } from '$app/state';
  import UserMenu from '$lib/components/UserMenu.svelte';
  import { PRODUCT_NAME } from '@thalermark/brand';

  let { children } = $props();

  const session = $derived(page.data.session);
</script>

<header class="border-b border-primary-200 bg-white">
  <div class="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
    <a href="/" class="font-semibold tracking-tight text-primary-900">{PRODUCT_NAME}</a>
    {#if session}
      <UserMenu name={session.user.name} email={session.user.email} />
    {/if}
  </div>
</header>

<main class="mx-auto max-w-5xl px-4 py-8">
  {@render children()}
</main>
