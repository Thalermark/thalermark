<script lang="ts">
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';

  let { children } = $props();

  // The airlock. "The Ledger" is the one deliberate place accounting vocabulary
  // shows through; this interstitial is what keeps the rest of the app plain —
  // you only meet debits/credits after walking through a clearly-marked door.
  //
  // Shown until acknowledged. The layout instance persists across navigation
  // WITHIN /ledger (so it doesn't re-prompt page-to-page) and remounts when you
  // leave and return (so every fresh entry is gated) — unless the user ticked
  // "don't show again", which we persist per-device in localStorage. Read
  // synchronously on the client (browser-guarded) so a dismissed user doesn't
  // see a post-hydration flash; SSR always renders the airlock (no storage).
  const DISMISS_KEY = 'ledger-airlock-dismissed';

  function dismissed(): boolean {
    try {
      return localStorage.getItem(DISMISS_KEY) === 'true';
    } catch {
      return false;
    }
  }

  let acknowledged = $state(browser && dismissed());
  let dontShowAgain = $state(false);

  function enter() {
    if (dontShowAgain) {
      try {
        localStorage.setItem(DISMISS_KEY, 'true');
      } catch {
        // Private mode / storage disabled — the dismiss just won't persist.
      }
    }
    acknowledged = true;
  }

  function goBack() {
    if (typeof history !== 'undefined' && history.length > 1) history.back();
    else goto('/');
  }
</script>

{#if acknowledged}
  {@render children()}
{:else}
  <div class="mx-auto max-w-xl">
    <div class="rounded-sm border border-fg/15 bg-surface-2 p-8">
      <span class="eyebrow text-accent">The Ledger</span>
      <h1 class="mt-3 font-serif text-3xl font-light leading-tight tracking-tight text-fg">
        The accounting layer under your books<span class="text-accent">.</span>
      </h1>
      <p class="mt-4 text-sm leading-relaxed text-fg/70">
        This is for adjustments your accountant tells you to make — debits, credits, and journal
        entries. Most people never need it. Everything you do day-to-day — invoices, expenses,
        getting paid — lives in the plain part of the app; this is the one place the raw accounting
        shows through.
      </p>
      <label class="mt-6 flex items-center gap-2 text-sm text-fg/70">
        <input type="checkbox" bind:checked={dontShowAgain} class="text-accent focus:ring-accent" />
        Don't show this again
      </label>
      <div class="mt-6 flex items-center gap-4">
        <button type="button" class="btn" onclick={enter}>Continue →</button>
        <button type="button" class="text-sm text-fg/60 hover:text-fg" onclick={goBack}>
          Go back
        </button>
      </div>
    </div>
  </div>
{/if}
