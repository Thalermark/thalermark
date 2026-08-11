<script lang="ts">
  import { type SparklineProps, formatValue, maxValue, runs, toNumber } from '@thalermark/charts';
  import { toneFill } from './tone.js';

  // A trend with no axis, no ticks and no chrome — the shape of a number's
  // recent history, sized to sit beside the number itself.
  //
  // Hand-drawn rather than run through LayerCake, deliberately. A sparkline has
  // no scale to share, no axis to align to and no coordinate context worth
  // building: it is one polyline over a fixed box. Reaching for the chart
  // engine here would cost a component instance per tile for arithmetic that
  // fits in six lines.
  //
  // It still speaks the same vocabulary — ChartValue in, SeriesTone out — so a
  // developer moves between this and ColumnChart without changing how they
  // think, which is the whole point of the module.

  let { values, label, tone = 'primary', height = 32 }: SparklineProps = $props();

  // The viewBox is arbitrary units; the SVG scales to whatever box it is given.
  // Percentages would work too, but a polyline needs numbers in one coordinate
  // space and 100x100 keeps the arithmetic readable.
  const W = 100;
  const H = 100;

  const ceiling = $derived(maxValue(values));
  const floor = $derived.by(() => {
    const nums = values.map(toNumber).filter((n): n is number => n !== null);
    return nums.length > 0 ? Math.min(0, ...nums) : 0;
  });

  // x is the index, y is the value against the series' own ceiling. A single
  // point has no line to draw, so the span guards against dividing by zero.
  const span = $derived(Math.max(1, values.length - 1));
  const range = $derived(Math.max(1e-9, (ceiling ?? 0) - floor));
  const pointAt = (index: number, value: number) => ({
    x: (index / span) * W,
    y: H - ((value - floor) / range) * H,
  });

  // One polyline per contiguous run, so a gap in the data is a GAP in the line
  // rather than a confident diagonal drawn across two months nobody recorded.
  const lines = $derived(
    runs(values).map((run) =>
      run.values.map((v, i) => {
        const p = pointAt(run.start + i, v);
        return `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
      }),
    ),
  );

  const last = $derived.by(() => {
    for (let i = values.length - 1; i >= 0; i--) {
      const n = toNumber(values[i] ?? null);
      if (n !== null) return { ...pointAt(i, n), value: values[i] ?? null };
    }
    return null;
  });

  // Two joinable points AND something to actually show. A brand-new account
  // has twelve gap-filled zeroes, which is a real answer to "how much" and a
  // meaningless one to "which way" — a flat line pinned to the baseline is
  // noise dressed as information, so it draws nothing.
  const hasLine = $derived(lines.some((l) => l.length > 1) && (ceiling ?? 0) > 0);
</script>

{#if hasLine}
  <!-- role=img with a label: a sparkline has no axis to carry a name and no
       table beside it, so the accessible name has to be the whole story. The
       last value is included because it is what a reader would actually want. -->
  <svg
    viewBox="0 0 {W} {H}"
    preserveAspectRatio="none"
    style="height: {height}px"
    class="w-full overflow-visible"
    role="img"
    aria-label="{label}. Latest {formatValue(last?.value ?? null)}."
  >
    {#each lines as points, i (i)}
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke={toneFill(tone)}
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        vector-effect="non-scaling-stroke"
      />
    {/each}
    {#if last}
      <!-- The most recent point, marked. Without it the eye has to find the
           end of the line, which is the one value that matters most. -->
      <circle cx={last.x} cy={last.y} r="2" fill={toneFill(tone)} vector-effect="non-scaling-stroke"
      ></circle>
    {/if}
  </svg>
{/if}
