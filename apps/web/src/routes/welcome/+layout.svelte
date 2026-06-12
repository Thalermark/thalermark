<script lang="ts">
  import { page } from '$app/state';

  let { children } = $props();

  // Three steps, keyed by path. Kept here (not in load) so the indicator
  // updates instantly on client-side nav between steps. Anything unmatched
  // (shouldn't happen inside this layout) falls back to step 1.
  const STEPS = ['/welcome', '/welcome/paid', '/welcome/brand'];
  const current = $derived(Math.max(0, STEPS.indexOf(page.url.pathname)) + 1);
</script>

<div class="flex min-h-screen flex-col">
  <nav class="px-6 py-8">
    <div class="mx-auto flex max-w-xl items-center justify-between">
      <span class="wordmark wordmark-small text-ink" aria-label="Thalermark">
        <span class="strike"></span>
        <span class="word">thalermark</span>
      </span>
      <span class="font-mono text-xs uppercase tracking-widest text-ink/50">
        Step {current} of {STEPS.length}
      </span>
    </div>
  </nav>

  <div class="mx-auto w-full max-w-xl px-6">
    <div class="flex gap-2" aria-hidden="true">
      {#each STEPS as _, i (i)}
        <span
          class="h-1 flex-1 rounded-full transition-colors {i < current
            ? 'bg-gold-deep'
            : 'bg-ink/15'}"
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
