<script lang="ts">
  // A horizontal strip of point-in-time metric tiles above a list page's
  // filter bar. Each tile is a click-through to its filtered view, so the
  // strip doubles as a live filter: `active` marks the currently-applied one,
  // `alert` tints the tile that wants attention (e.g. overdue > 0). `value` is
  // the headline (a count); `sub` is an optional secondary line (e.g. a $
  // amount) shown only on money-bearing buckets.
  type Tile = {
    label: string;
    value: string | number;
    sub?: string;
    href: string;
    active?: boolean;
    alert?: boolean;
  };
  let { tiles }: { tiles: Tile[] } = $props();
</script>

<dl class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
  {#each tiles as t (t.label)}
    <a
      href={t.href}
      aria-current={t.active ? 'true' : undefined}
      class="rounded-sm border p-3 transition-colors {t.alert
        ? 'border-danger/30 bg-danger/5 hover:border-danger/50'
        : t.active
          ? 'border-accent bg-accent/5'
          : 'border-fg/10 bg-surface-2 hover:border-fg/25'}"
    >
      <dt class="label">{t.label}</dt>
      <dd class="mt-1 font-serif text-xl font-light tabular-nums text-fg">{t.value}</dd>
      {#if t.sub}
        <p class="mt-0.5 text-xs tabular-nums text-fg/40">{t.sub}</p>
      {/if}
    </a>
  {/each}
</dl>
