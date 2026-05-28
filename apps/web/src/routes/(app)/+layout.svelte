<script lang="ts">
  import { page } from '$app/state';
  import UserMenu from '$lib/components/UserMenu.svelte';

  let { children } = $props();

  const session = $derived(page.data.session);
</script>

<header class="border-b border-ink/10 bg-cream">
  <div class="mx-auto flex max-w-5xl items-center justify-between gap-6 px-6 py-6">
    <a href="/" class="wordmark wordmark-small text-ink" aria-label="Thalermark home">
      <span class="strike"></span>
      <span class="word">thalermark</span>
    </a>
    {#if session}
      <nav class="flex items-center gap-6 font-mono text-xs uppercase tracking-widest text-ink/60">
        <a href="/invoices" class="hover:text-ink">Invoices</a>
        <a href="/estimates" class="hover:text-ink">Estimates</a>
        <a href="/customers" class="hover:text-ink">Customers</a>
      </nav>
      <UserMenu name={session.user.name} email={session.user.email} />
    {/if}
  </div>
</header>

<main class="mx-auto max-w-5xl px-6 py-12">
  {@render children()}
</main>
