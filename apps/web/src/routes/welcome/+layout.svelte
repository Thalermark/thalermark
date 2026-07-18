<script lang="ts">
  import { beforeNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import { flushTelemetry, trackEvent } from '$lib/telemetry';

  let { children } = $props();

  // Three steps, keyed by path. Kept here (not in load) so the indicator
  // updates instantly on client-side nav between steps. Anything unmatched
  // (shouldn't happen inside this layout) falls back to step 1.
  const STEPS = ['/welcome', '/welcome/paid', '/welcome/brand'];
  const current = $derived(Math.max(0, STEPS.indexOf(page.url.pathname)) + 1);

  // onboarding_abandoned: fire when the user leaves the wizard (any non-/welcome
  // destination, incl. a tab unload where `to` is null) before the final step.
  // Intra-wizard hops stay inside /welcome so they don't count; leaving from the
  // last step (/welcome/brand) is treated as finishing, not abandoning. The
  // wizard has no escape nav, so in practice this only catches back/close/manual
  // URL changes — low volume by design.
  let abandonmentFired = false;
  beforeNavigate((nav) => {
    if (abandonmentFired) return;
    const from = page.url.pathname;
    const to = nav.to?.url.pathname;
    if (to?.startsWith('/welcome')) return; // still inside the wizard
    if (from === '/welcome/brand') return; // reached the last step = finished enough
    abandonmentFired = true;
    trackEvent({
      name: 'onboarding_abandoned',
      last_completed_step: from === '/welcome' ? null : 'company_setup',
    });
    void flushTelemetry();
  });
</script>

<div class="flex min-h-screen flex-col">
  <nav class="px-6 py-8">
    <div class="mx-auto flex max-w-xl items-center justify-between">
      <span class="wordmark wordmark-small text-fg" aria-label="Thalermark">
        <span class="strike"></span>
        <span class="word">thalermark</span>
      </span>
      <span class="label">
        Step {current} of {STEPS.length}
      </span>
    </div>
  </nav>

  <div class="mx-auto w-full max-w-xl px-6">
    <div class="flex gap-2" aria-hidden="true">
      {#each STEPS as _, i (i)}
        <span
          class="h-1 flex-1 rounded-full transition-colors {i < current
            ? 'bg-accent'
            : 'bg-fg/15'}"
        ></span>
      {/each}
    </div>
  </div>

  <main class="flex flex-1 justify-center px-6 pb-16 pt-10">
    <div class="w-full max-w-xl">
      {@render children()}
    </div>
  </main>
</div>
