<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  // Prefer the freshest state: the action's returned telemetry (after a save)
  // wins over the loader's, so the toggle reflects the just-made choice.
  const telemetry = $derived(form?.telemetry ?? data.telemetry);
</script>

<h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
  Privacy<span class="text-accent">.</span>
</h1>

<section class="mt-8 rounded-sm border border-fg/15 bg-surface-2">
  <header class="border-b border-fg/10 px-6 py-5">
    <span class="eyebrow">Usage data</span>
    <p class="mt-2 text-sm text-fg/70">
      Help us build a better product. With your consent we collect anonymous usage data — which
      features get used and where errors happen. We never collect personal or financial information:
      no names, amounts, contacts, or document contents. You can change this any time, and the
      <a class="link" href="https://github.com/thalermark/thalermark/blob/main/TELEMETRY.md">
        full spec is public</a
      >.
    </p>
  </header>

  {#if telemetry.disabled}
    <div class="px-6 py-6 text-sm text-fg/70">
      Usage data is turned off for this installation by the
      <span class="font-mono text-xs">TELEMETRY_DISABLED</span> setting on the server. Nothing is collected,
      and there's nothing to change here.
    </div>
  {:else}
    <form method="POST" class="grid gap-6 px-6 py-6">
      <label class="flex items-center gap-3 text-sm text-fg">
        <input
          type="checkbox"
          name="enabled"
          checked={telemetry.enabled}
          class="size-4 rounded-sm border-fg/30 text-accent focus:ring-accent"
        />
        Share anonymous usage data
      </label>
      <div class="flex items-center gap-4">
        <button type="submit" class="btn">Save</button>
        {#if form?.saved}
          <span class="text-sm text-fg/60">Saved.</span>
        {/if}
        {#if form?.saveError}
          <span class="text-sm text-danger">Couldn't save: {form.saveError}</span>
        {/if}
      </div>
    </form>
  {/if}
</section>
