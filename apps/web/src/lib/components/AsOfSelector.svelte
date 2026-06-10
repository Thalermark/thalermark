<script lang="ts">
  // Single as-of date picker for point-in-time reports (balance sheet, A/R
  // aging). URL-backed (?asOf=) GET form so the loader re-runs server-side.
  let { asOf }: { asOf: string } = $props();
</script>

<form method="GET" class="mt-6 flex items-end gap-2">
  <label class="flex flex-col gap-1 text-xs uppercase tracking-widest text-ink/50">
    As of
    <input
      type="date"
      name="asOf"
      value={asOf}
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
