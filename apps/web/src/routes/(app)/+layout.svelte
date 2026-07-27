<script lang="ts">
  import { page } from '$app/state';
  import LegalConsent from '$lib/components/LegalConsent.svelte';
  import TelemetryConsent from '$lib/components/TelemetryConsent.svelte';
  import UserMenu from '$lib/components/UserMenu.svelte';
  import { may } from '$lib/perms';
  import { startSessionTracking } from '$lib/session-telemetry';
  import { setTelemetryEnabled } from '$lib/telemetry';
  import { onMount } from 'svelte';

  let { children, data } = $props();

  const session = $derived(page.data.session);
  // Account notice — the open-core seam. Null on self-host (no banner); the
  // managed backend surfaces a frozen/lapsed → upgrade notice. Warning variant
  // uses the copper status tint, info the gold accent (matching .callout).
  const notice = $derived(page.data.notice ?? null);
  const noticeClass = $derived(
    notice?.variant === 'warning'
      ? 'border-warning/30 bg-warning/5 text-warning'
      : 'border-accent/30 bg-accent/5 text-fg/80',
  );
  // Company switcher data from the (app) layout server load. Empty on the
  // exempt paths (e.g. /select-company) — UserMenu hides the section then.
  const companies = $derived(data?.companies ?? []);
  const activeCompanyId = $derived(data?.activeCompanyId ?? null);
  // Working inside a business that has stopped trading. Its records stay
  // readable — that's the point — but nothing new can be recorded against it,
  // and someone who switched to it for a report should be told rather than
  // discovering it when a save fails.
  const activeRetired = $derived(
    companies.some((c) => c.id === activeCompanyId && c.retiredAt != null),
  );
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

  // Session tracking. Set the gate from load data first so the initial
  // session_start isn't dropped before the reactive effect above runs, then
  // start (and, on teardown, close) the session. Client-only via onMount.
  onMount(() => {
    setTelemetryEnabled(data?.telemetry?.enabled ?? false);
    return startSessionTracking();
  });

  // Legal-consent gate (spikes/SIGN-UP-ACK-TOS.md). When the deployment requires
  // consent and this person hasn't accepted the current terms version, the wall
  // REPLACES the app content below — every (app) route renders the same layout,
  // so there's no way past it until they accept. required:false (default
  // self-host) → never shown. Applies to every role and every sign-up door.
  const showLegalConsent = $derived(!!data?.legal?.required && !data.legal.accepted);

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
  {#if activeRetired}
    <div class="callout mb-8">
      <p class="text-sm text-fg/70">
        <span class="text-fg">You're looking at a closed business.</span>
        Everything here is still readable and every report still works, so you can file for it —
        but you can't record new work against it.
        <a href="/settings/business" class="link">Business settings</a>.
      </p>
    </div>
  {/if}
  {#if showLegalConsent}
    <LegalConsent
      termsUrl={data.legal?.termsUrl ?? '/legal/terms'}
      privacyUrl={data.legal?.privacyUrl ?? '/legal/privacy'}
    />
  {:else}
    {#if notice}
      <div
        class="mb-8 flex flex-wrap items-center justify-between gap-3 rounded-sm border px-4 py-3 text-sm {noticeClass}"
        role="status"
      >
        <span>{notice.message}</span>
        <a href={notice.ctaHref} class="link whitespace-nowrap font-medium">{notice.ctaLabel}</a>
      </div>
    {/if}
    {#if showTelemetryConsent}
      <TelemetryConsent />
    {/if}
    {@render children()}
  {/if}
</main>
