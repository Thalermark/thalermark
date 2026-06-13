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
  <div class="flex flex-wrap gap-1 rounded-sm border border-fg/15 bg-surface-2 p-1 font-mono text-xs uppercase tracking-widest">
    {#each presets as p (p.key)}
      <a
        href="?from={p.from}&to={p.to}"
        class="rounded-sm px-3 py-1 transition-colors {activeKey === p.key
          ? 'bg-inverse text-on-inverse'
          : 'text-fg/60 hover:text-fg'}"
      >
        {p.label}
      </a>
    {/each}
  </div>

  <form method="GET" class="flex items-end gap-2">
    <label class="flex flex-col gap-1 text-xs uppercase tracking-widest text-fg/50">
      From
      <input
        type="date"
        name="from"
        value={from}
        class="rounded-sm border border-fg/15 bg-surface px-2 py-1.5 text-sm normal-case tracking-normal text-fg"
      />
    </label>
    <label class="flex flex-col gap-1 text-xs uppercase tracking-widest text-fg/50">
      To
      <input
        type="date"
        name="to"
        value={to}
        class="rounded-sm border border-fg/15 bg-surface px-2 py-1.5 text-sm normal-case tracking-normal text-fg"
      />
    </label>
    <button
      type="submit"
      class="btn"
    >
      Apply
    </button>
  </form>
</div>
