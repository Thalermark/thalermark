<script lang="ts">
  // Single as-of date picker for point-in-time reports (balance sheet, A/R
  // aging). URL-backed (?asOf=) GET form so the loader re-runs server-side.
  let { asOf }: { asOf: string } = $props();
</script>

<form method="GET" class="mt-6 flex items-end gap-2">
  <label class="flex flex-col gap-1 text-xs uppercase tracking-widest text-fg/50">
    As of
    <input
      type="date"
      name="asOf"
      value={asOf}
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
