<script lang="ts">
  // The shared "nothing here" block for list pages.
  //
  // Every list used to end at a bare sentence — "No invoices yet." — with no way
  // forward, under a filter bar offering four ways to slice zero rows. The
  // sentence told the user what they did not have and then abandoned them
  // (TMC-234).
  //
  // Two shapes, and the difference matters. An UNFILTERED empty list is a new
  // user who needs the thing made; the action is "create one". A FILTERED empty
  // list is someone who has data and cannot see it; the action is "undo the
  // filter". Offering "+ New invoice" to someone whose filters merely hid their
  // invoices is answering a question they did not ask.
  //
  // The action is optional because a role without write capability must not be
  // shown a button that 403s. Callers pass it only when `may(...)` says so, the
  // same gate their header button already uses.
  let {
    message,
    actionHref,
    actionLabel,
  }: { message: string; actionHref?: string; actionLabel?: string } = $props();
</script>

<div class="mt-8 rounded-sm border border-fg/10 bg-surface-2 px-6 py-10 text-center">
  <p class="text-fg/70">{message}</p>
  {#if actionHref && actionLabel}
    <a href={actionHref} class="btn mt-5 inline-block px-5 py-2">{actionLabel}</a>
  {/if}
</div>
