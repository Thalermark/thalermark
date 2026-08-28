<script lang="ts">
  import { navigating } from '$app/state';

  // A navigation progress bar (TMC-237).
  //
  // SvelteKit intercepts every in-app link, so clicking Reports — or any of the
  // uncached server-loaded reports (profit-and-loss, general-ledger,
  // tax-worksheet) — leaves the previous page fully rendered and interactive
  // with no sign anything is happening. On a slow connection that reads as a
  // dead click and invites a second one. Mobile already handles this; web had
  // nothing at all.
  //
  // Deliberately delayed: a fast navigation should show NOTHING rather than a
  // bar that flashes on and off, which reads as a glitch. Only a wait long
  // enough to be doubted gets an indicator.
  const DELAY_MS = 250;

  let visible = $state(false);

  $effect(() => {
    // Reading `navigating.to` is what subscribes this effect.
    if (!navigating.to) {
      visible = false;
      return;
    }
    const timer = setTimeout(() => {
      visible = true;
    }, DELAY_MS);
    // Cleared when the navigation finishes, which is also what stops a fast one
    // from ever showing.
    return () => clearTimeout(timer);
  });
</script>

{#if visible}
  <!-- aria-hidden: the bar is decoration. The status message beside it is what a
       screen reader announces, and it is polite so it does not interrupt. -->
  <div
    class="fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden bg-transparent"
    aria-hidden="true"
  >
    <div class="nav-progress h-full bg-accent"></div>
  </div>
  <span class="sr-only" role="status" aria-live="polite">Loading the next page</span>
{/if}

<style>
  /* Indeterminate: the real duration is unknown, so the bar reports "still
     working" rather than faking a percentage. */
  .nav-progress {
    width: 40%;
    animation: nav-progress-slide 1.1s ease-in-out infinite;
  }

  @keyframes nav-progress-slide {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(350%);
    }
  }

  /* Someone who asked for less motion gets a static bar, not a moving one. */
  @media (prefers-reduced-motion: reduce) {
    .nav-progress {
      width: 100%;
      animation: none;
      opacity: 0.6;
    }
  }
</style>
