<script lang="ts">
  import type { ShareBarProps } from '@thalermark/charts';
  import { toneFill } from './tone.js';

  // The proportional bar that lives in a table cell.
  //
  // DELIBERATELY NOT A CHART. Three of this repo's five hand-rolled bar sites
  // are table rows, and sales-by-customer renders up to 25 of them. A
  // scale-owning chart component per row — each with its own coordinate
  // context — is a real regression over a div with a width percentage, for a
  // shape that carries no axis, no scale and no second dimension.
  //
  // It lives in the charts module anyway, so a developer reaching for "show a
  // proportion" finds one answer instead of copying markup for the fourth time.
  // The tone vocabulary is shared with the real charts; only the renderer
  // differs.

  let { value, tone = 'primary', showPercent = true }: ShareBarProps = $props();

  // 0..1 in, clamped. A share above 1 is a data bug upstream, and a bar wider
  // than its track would hide it.
  const pct = $derived(Math.max(0, Math.min(1, value)) * 100);
</script>

<div class="flex items-center gap-2">
  <div class="h-2 flex-1 overflow-hidden rounded-full bg-fg/10">
    <div class="h-full rounded-full" style="width: {pct}%; background: {toneFill(tone)}"></div>
  </div>
  {#if showPercent}
    <!-- w-10 matches the two call sites this replaced, so the percentage column
         keeps its width and the tables do not reflow. -->
    <span class="w-10 text-right font-mono text-xs tabular-nums text-fg/50">{Math.round(pct)}%</span
    >
  {/if}
</div>
