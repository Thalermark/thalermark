<script lang="ts">
  import { authClient } from '$lib/auth-client';
  import { goto } from '$app/navigation';
  import { COPY } from '@thalermark/brand';

  let { children } = $props();

  async function signOut() {
    await authClient.signOut();
    await goto('/sign-in');
  }
</script>

<header class="border-b border-primary-200 bg-white">
  <div class="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
    <a href="/" class="font-semibold tracking-tight text-primary-900">Thalermark</a>
    <button
      type="button"
      onclick={signOut}
      class="text-sm text-primary-600 hover:text-primary-900"
    >
      {COPY.signOut}
    </button>
  </div>
</header>

<main class="mx-auto max-w-5xl px-4 py-8">
  {@render children()}
</main>
