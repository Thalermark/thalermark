<script lang="ts">
  import { page } from '$app/state';
  import TelemetryConsent from '$lib/components/TelemetryConsent.svelte';
  import UserMenu from '$lib/components/UserMenu.svelte';
  import { may } from '$lib/perms';
  import { setTelemetryEnabled } from '$lib/telemetry';

  let { children, data } = $props();

  const session = $derived(page.data.session);
  // Company switcher data from the (app) layout server load. Empty on the
  // exempt paths (e.g. /select-company) — UserMenu hides the section then.
  const companies = $derived(data?.companies ?? []);
  const activeCompanyId = $derived(data?.activeCompanyId ?? null);
  // Creating a company + the account-wide telemetry decision are both
  // settings:manage (owner/admin); switching companies is open to every role.
  const canManageSettings = $derived(may(page.data.role, 'settings:manage'));
  // "The Ledger" — the gated manual-adjustment portal. Owner/admin/accountant
  // only; the link is the deliberate (and only) door into accounting vocabulary.
  const canAdjustLedger = $derived(may(page.data.role, 'ledger:adjust'));
  // First-run telemetry consent: shown only to settings:manage roles (they own
  // the account-wide decision), once the account hasn't decided and the
  // deployment hasn't disabled it.
  const showTelemetryConsent = $derived(
    canManageSettings &&
      !!data?.telemetry &&
      !data.telemetry.decided &&
      !data.telemetry.disabled,
  );

  // Keep the client telemetry emitter's gate in sync with the account's opt-in
  // (every member, not just admins — report views come from any role).
  $effect(() => {
    setTelemetryEnabled(data?.telemetry?.enabled ?? false);
  });
</script>

<header class="border-b border-fg/10 bg-surface print:hidden">
  <div class="mx-auto flex max-w-5xl items-center justify-between gap-6 px-6 py-6">
    <a href="/" class="wordmark wordmark-small text-fg" aria-label="Thalermark home">
      <span class="strike"></span>
      <span class="word">thalermark</span>
    </a>
    {#if session}
      <nav class="flex items-center gap-6 font-mono text-xs uppercase tracking-widest text-fg/60">
        <a href="/invoices" class="hover:text-fg">Invoices</a>
        <a href="/recurring" class="hover:text-fg">Recurring</a>
        <a href="/estimates" class="hover:text-fg">Estimates</a>
        <a href="/expenses" class="hover:text-fg">Expenses</a>
        <a href="/contacts" class="hover:text-fg">Contacts</a>
        <a href="/reports" class="hover:text-fg">Reports</a>
      </nav>
      <UserMenu
        name={session.user.name}
        email={session.user.email}
        {companies}
        {activeCompanyId}
        canManageCompanies={canManageSettings}
        {canAdjustLedger}
        currentPath={page.url.pathname + page.url.search}
      />
    {/if}
  </div>
</header>

<main class="mx-auto max-w-5xl px-6 py-12">
  {#if showTelemetryConsent}
    <TelemetryConsent />
  {/if}
  {@render children()}
</main>
