<script lang="ts">
  import { beforeNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import {
    WELCOME_FINISHED_FROM,
    WELCOME_STEPS,
    welcomeStepNumber,
  } from '$lib/welcome-steps';
  import { flushTelemetry, trackEvent } from '$lib/telemetry';

  let { children } = $props();

  // Steps live in $lib so a test can pin them against the routes directory. They
  // were inline here, drifted out of date, and took the counter and the
  // abandonment event down together (TMC-234 — the reasoning is recorded there).
  const STEPS = WELCOME_STEPS;
  const current = $derived(welcomeStepNumber(page.url.pathname));

  // onboarding_abandoned: fire when the user leaves the wizard (any non-/welcome
  // destination, incl. a tab unload where `to` is null) before finishing.
  // Intra-wizard hops stay inside /welcome so they don't count. The wizard has no
  // escape nav, so in practice this only catches back/close/manual URL changes —
  // low volume by design.
  let abandonmentFired = false;
  beforeNavigate((nav) => {
    if (abandonmentFired) return;
    const from = page.url.pathname;
    const to = nav.to?.url.pathname;
    if (to?.startsWith('/welcome')) return; // still inside the wizard
    if (WELCOME_FINISHED_FROM.has(from)) return;
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
