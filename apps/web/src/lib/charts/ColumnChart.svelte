<script lang="ts" generics="Row">
  import {
    type ColumnChartProps,
    formatValue,
    maxValue,
    toNumber,
    toneForIndex,
  } from '@thalermark/charts';
  import { Html, LayerCake, Svg } from 'layercake';
  import { scaleBand } from 'd3-scale';
  import ChartFrame from './ChartFrame.svelte';
  import { toneFill } from './tone.js';

  // Vertical bars over a categorical or time axis.
  //
  // WHY THE TICK LABELS LIVE IN A LAYERCAKE <Html> LAYER. The chart this
  // replaces drew its bars in one flex row and its month labels in a SECOND,
  // parallel flex row, keeping them aligned by duplicating `gap-1.5`,
  // `min-w-6` and `flex-1` across both. That is alignment by coincidence: edit
  // one row's spacing and the labels silently slide off the bars. Here both
  // layers are positioned by LayerCake against the same padded box and the same
  // band scale, so they cannot drift — the labels sit at the band's own centre
  // by construction.
  //
  // WHY `ssr` + `percentRange`. Coordinates come out as percentages instead of
  // pixels, so the marks need no measured container and render on the SERVER.
  // Combined with ChartFrame's table that means the chart exists — really
  // exists, as geometry — before any JavaScript runs.

  // The band scale as this component consumes it — the domain value in, the
  // band's left edge out, plus its width. d3's ScaleBand type would do, but
  // naming the two members used keeps the LayerCake seam explicit.
  type BandScale = {
    (value: string): number | undefined;
    bandwidth(): number;
  };

  let { data, x, series, caption, format = 'money', height = 224, empty }: ColumnChartProps<Row> =
    $props();

  // Reserved strip below the plot for the tick labels. The <Html> layer renders
  // into it by overflowing the padded box, which is why LayerCake's padding and
  // this constant have to agree.
  const LABEL_BAND = 22;

  const rows = $derived([...data]);

  // The domain is the x key's value per row, so the band scale and the labels
  // agree on identity even when two rows format to the same tick text.
  const domain = $derived(rows.map((row) => String((row as Record<string, unknown>)[x.key])));

  // One shared ceiling across every series, so two series are comparable by
  // eye. maxValue returns null for an all-unknown series — distinct from 0,
  // which is a real flat chart.
  const ceiling = $derived.by(() => {
    const all = rows.flatMap((row) =>
      series.map((s) => (row as Record<string, unknown>)[s.key] as string | null),
    );
    return maxValue(all);
  });
</script>

<ChartFrame {data} {x} {series} {caption} {format} {height} {empty}>
  {#snippet chart()}
    <div class="h-full w-full">
      <LayerCake
        data={rows}
        x={(d: Row) => String((d as Record<string, unknown>)[x.key])}
        xScale={scaleBand().paddingInner(0.28).paddingOuter(0.14)}
        xDomain={domain}
        yDomain={[0, ceiling ?? 0]}
        padding={{ top: 4, right: 0, bottom: LABEL_BAND, left: 0 }}
        ssr
        percentRange
      >
        <!-- LayerCake is JSDoc-typed, so its snippet parameters arrive as
             `any`. Annotated here with the slice actually used, which is also
             the honest contract: this chart needs a band scale and nothing
             else from the coordinate context. -->
        {#snippet children({ xScale }: { xScale: BandScale })}
          <Svg>
            <!-- Three gridlines and no numeric axis, matching the chart being
                 replaced. The exact figures are one hover away and always in
                 the accessible table; a y-axis of compacted money on a 24px
                 tick is noise this layout does not need. -->
            {#each [0.25, 0.5, 0.75] as at (at)}
              <line
                x1="0%"
                x2="100%"
                y1="{at * 100}%"
                y2="{at * 100}%"
                stroke="rgb(var(--fg) / 0.07)"
                stroke-width="1"
              />
            {/each}

            {#each rows as row, rowIndex (domain[rowIndex])}
              {@const bandStart = xScale(domain[rowIndex]) ?? 0}
              {@const bandWidth = xScale.bandwidth()}
              {#each series as s, seriesIndex (s.key)}
                {@const value = toNumber((row as Record<string, unknown>)[s.key] as string | null)}
                {#if value !== null && ceiling !== null && ceiling > 0}
                  {@const topPct = 100 - (value / ceiling) * 100}
                  <!-- Several series share a band, each taking an equal slice.
                       With one series that is the whole band, so the common
                       case pays nothing for the general one. -->
                  <rect
                    x="{bandStart + (bandWidth / series.length) * seriesIndex}%"
                    y="{topPct}%"
                    width="{bandWidth / series.length}%"
                    height="{100 - topPct}%"
                    fill={toneFill(s.tone ?? toneForIndex(seriesIndex))}
                  >
                    <title
                      >{x.label(row)}: {formatValue(
                        (row as Record<string, unknown>)[s.key] as string | null,
                        format,
                      )}</title
                    >
                  </rect>
                {/if}
              {/each}
            {/each}
          </Svg>

          <Html pointerEvents={false}>
            {#each rows as row, rowIndex (domain[rowIndex])}
              {@const bandStart = xScale(domain[rowIndex]) ?? 0}
              <span
                class="absolute truncate text-center font-mono text-[10px] uppercase tracking-wide text-fg/50"
                style="left: {bandStart}%; width: {xScale.bandwidth()}%; top: 100%; padding-top: 6px;"
              >
                {x.label(row)}
              </span>
            {/each}
          </Html>
        {/snippet}
      </LayerCake>
    </div>
  {/snippet}
</ChartFrame>
