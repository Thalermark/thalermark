<script lang="ts">
  // Shared footer for keyset-paginated lists. Renders nothing once the list is
  // exhausted (hasMore false). The page owns the rows/cursor state and the
  // append logic; this is purely the button + its loading/error affordances.
  let {
    hasMore,
    loading,
    error = false,
    onclick,
  }: {
    hasMore: boolean;
    loading: boolean;
    error?: boolean;
    onclick: () => void;
  } = $props();
</script>

{#if hasMore}
  <div class="mt-6 flex flex-col items-center gap-2">
    <button
      type="button"
      {onclick}
      disabled={loading}
      class="rounded-sm border border-fg/15 px-4 py-2 font-mono text-xs uppercase tracking-widest text-fg/60 transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
    >
      {loading ? 'Loading…' : 'Load more'}
    </button>
    {#if error}
      <p class="text-sm text-danger">Couldn’t load more. Try again.</p>
    {/if}
  </div>
{/if}
