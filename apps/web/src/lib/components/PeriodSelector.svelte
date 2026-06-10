<script lang="ts">
  import type { Preset } from '$lib/reports.server';

  // Reporting-window picker shared by the report pages: quick preset links
  // (This month / quarter / YTD / Last year) plus a custom from–to GET form.
  // Everything lives in the URL (?from=&to=) so the loader re-runs server-side
  // and the window is shareable / back-button friendly. The active preset (or
  // the resolved from/to) is computed server-side and passed in.
  type Props = {
    presets: Preset[];
    activeKey: string | null;
    from: string;
    to: string;
  };
  let { presets, activeKey, from, to }: Props = $props();
</script>

<div class="mt-6 flex flex-wrap items-end justify-between gap-4">
  <div class="flex flex-wrap gap-1 rounded-sm border border-ink/15 bg-cream-warm p-1 font-mono text-xs uppercase tracking-widest">
    {#each presets as p (p.key)}
      <a
        href="?from={p.from}&to={p.to}"
        class="rounded-sm px-3 py-1 transition-colors {activeKey === p.key
          ? 'bg-ink text-cream'
          : 'text-ink/60 hover:text-ink'}"
      >
        {p.label}
      </a>
    {/each}
  </div>

  <form method="GET" class="flex items-end gap-2">
    <label class="flex flex-col gap-1 text-xs uppercase tracking-widest text-ink/50">
      From
      <input
        type="date"
        name="from"
        value={from}
        class="rounded-sm border border-ink/15 bg-cream px-2 py-1.5 text-sm normal-case tracking-normal text-ink"
      />
    </label>
    <label class="flex flex-col gap-1 text-xs uppercase tracking-widest text-ink/50">
      To
      <input
        type="date"
        name="to"
        value={to}
        class="rounded-sm border border-ink/15 bg-cream px-2 py-1.5 text-sm normal-case tracking-normal text-ink"
      />
    </label>
    <button
      type="submit"
      class="rounded-sm bg-ink px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
    >
      Apply
    </button>
  </form>
</div>
