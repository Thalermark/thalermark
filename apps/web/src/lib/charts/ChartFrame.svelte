<script lang="ts" generics="Row">
  import { type ChartProps, seriesTable } from '@thalermark/charts';
  import type { Snippet } from 'svelte';

  // The wrapper every chart in this app renders inside.
  //
  // It exists to make two things unconditional rather than remembered:
  //
  // 1. THE ACCESSIBLE TABLE. The marks are aria-hidden and this table is the
  //    one representation a screen reader gets — a caption and real rows,
  //    instead of a pile of unlabelled shapes.
  //
  // 2. THE NO-JAVASCRIPT CHART. SSR is on for every route here and there are no
  //    client-only loads, so the table is server-rendered whatever the drawing
  //    layer manages. A reader with JS off, a crawler and a curl all get the
  //    full series. That is why the table is built from `seriesTable()` — a
  //    pure function with its own tests — rather than assembled inline.
  //
  // The height is reserved on the frame, not inside the chart, so the page does
  // not shift when marks appear.

  type Props = ChartProps<Row> & {
    height: number;
    chart: Snippet;
  };

  let { data, x, series, caption, format, height, empty, chart }: Props = $props();

  const table = $derived(seriesTable({ data, x, series, format }));
  const hasData = $derived(data.length > 0);
</script>

<figure class="m-0">
  {#if hasData}
    <!-- aria-hidden: the table below is the accessible version, and announcing
         both would read the same series twice. -->
    <div aria-hidden="true" style="height: {height}px">
      {@render chart()}
    </div>

    <table class="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {#each table.head as heading (heading)}
            <th scope="col">{heading}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each table.rows as row, i (i)}
          <tr>
            {#each row as cell, j (j)}
              {#if j === 0}
                <th scope="row">{cell}</th>
              {:else}
                <td>{cell}</td>
              {/if}
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <!-- A sentence, not an empty axis frame. An axis with nothing on it looks
         like a chart that failed to load. -->
    <p class="text-fg/70">{empty ?? 'Nothing to show for this period.'}</p>
  {/if}
</figure>
