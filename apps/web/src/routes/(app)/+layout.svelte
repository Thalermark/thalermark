<script lang="ts">
  import { page } from '$app/state';
  import UserMenu from '$lib/components/UserMenu.svelte';
  import { may } from '$lib/perms';

  let { children, data } = $props();

  const session = $derived(page.data.session);
  // Company switcher data from the (app) layout server load. Empty on the
  // exempt paths (e.g. /select-company) — UserMenu hides the section then.
  const companies = $derived(data?.companies ?? []);
  const activeCompanyId = $derived(data?.activeCompanyId ?? null);
  // Creating a company is settings:manage (owner/admin), matching the API gate;
  // switching is open to every role. Hide "+ Add company" for those who can't.
  const canManageCompanies = $derived(may(page.data.role, 'settings:manage'));
</script>

<header class="border-b border-ink/10 bg-cream print:hidden">
  <div class="mx-auto flex max-w-5xl items-center justify-between gap-6 px-6 py-6">
    <a href="/" class="wordmark wordmark-small text-ink" aria-label="Thalermark home">
      <span class="strike"></span>
      <span class="word">thalermark</span>
    </a>
    {#if session}
      <nav class="flex items-center gap-6 font-mono text-xs uppercase tracking-widest text-ink/60">
        <a href="/invoices" class="hover:text-ink">Invoices</a>
        <a href="/recurring" class="hover:text-ink">Recurring</a>
        <a href="/estimates" class="hover:text-ink">Estimates</a>
        <a href="/expenses" class="hover:text-ink">Expenses</a>
        <a href="/customers" class="hover:text-ink">Customers</a>
        <a href="/reports" class="hover:text-ink">Reports</a>
      </nav>
      <UserMenu
        name={session.user.name}
        email={session.user.email}
        {companies}
        {activeCompanyId}
        {canManageCompanies}
        currentPath={page.url.pathname + page.url.search}
      />
    {/if}
  </div>
</header>

<main class="mx-auto max-w-5xl px-6 py-12">
  {@render children()}
</main>
