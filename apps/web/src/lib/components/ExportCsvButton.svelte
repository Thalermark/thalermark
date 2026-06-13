<script lang="ts">
  import { type CsvCell, downloadCsv } from '$lib/csv';

  // Download-to-CSV control for the report pages. The caller passes the fully
  // built rows (header first) and a filename; the click turns them into a file
  // in the browser — no round trip, since the report's data is already loaded.
  type Props = {
    filename: string;
    rows: CsvCell[][];
    label?: string;
    // Disabled when there's nothing to export (empty report) so the control
    // reads honestly rather than handing back a header-only file.
    disabled?: boolean;
  };
  let { filename, rows, label = 'Export CSV', disabled = false }: Props = $props();
</script>

<button
  type="button"
  {disabled}
  onclick={() => downloadCsv(filename, rows)}
  class="inline-flex items-center gap-2 rounded-sm border border-fg/15 bg-surface-2 px-4 py-2 text-sm font-medium text-fg transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-fg/15 disabled:hover:text-fg"
>
  <svg
    class="h-4 w-4"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M12 3v12m0 0l-4-4m4 4l4-4" />
    <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
  </svg>
  {label}
</button>
