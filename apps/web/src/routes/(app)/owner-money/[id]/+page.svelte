<script lang="ts">
  import AuditHistory from '$lib/components/AuditHistory.svelte';
  import { may } from '$lib/perms';
  import type { PageProps } from './$types';
  import { kindLabel } from '../owner-money-rows';

  let { data, form }: PageProps = $props();
  const e = $derived(data.event);
  const isIn = $derived(e.kind === 'contribution');

  // Role gate (UX only — the API is authoritative). Recording / editing /
  // deleting owner money is the expenses:write cluster.
  const canWrite = $derived(may(data.role, 'expenses:write'));
</script>

<a href="/owner-money" class="eyebrow text-fg/60 hover:text-fg">← Owner money</a>
<div class="mt-3 flex items-baseline justify-between gap-6">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
    {kindLabel(e.kind)}<span class="text-accent">.</span>
  </h1>
  {#if canWrite}
    <div class="flex items-center gap-3">
      <a
        href="/owner-money/{e.id}/edit"
        class="rounded-sm border border-fg/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70 hover:border-accent hover:text-accent"
      >
        Edit
      </a>
      <form method="post" action="?/delete">
        <button
          type="submit"
          class="rounded-sm border border-danger/30 px-3 py-1 font-mono text-xs uppercase tracking-widest text-danger/80 hover:border-danger hover:text-danger"
        >
          Delete
        </button>
      </form>
    </div>
  {/if}
</div>

{#if form?.deleteError}
  <div class="mt-4 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    Could not delete this: {form.deleteError}
  </div>
{/if}

<dl class="mt-8 grid grid-cols-1 gap-x-12 gap-y-6 sm:grid-cols-2">
  <div>
    <dt class="label">Amount</dt>
    <dd class="mt-1 font-mono tabular-nums {isIn ? 'text-success' : 'text-fg'}">
      {isIn ? '+' : '−'}{e.amount}
    </dd>
  </div>
  <div>
    <dt class="label">Date</dt>
    <dd class="mt-1 font-mono tabular-nums text-fg">{e.occurredOn}</dd>
  </div>
  <div>
    <dt class="label">Type</dt>
    <dd class="mt-1 text-fg">{isIn ? 'You put money in' : 'You took money out'}</dd>
  </div>
  {#if e.memo}
    <div class="sm:col-span-2">
      <dt class="label">Note</dt>
      <dd class="mt-1 whitespace-pre-wrap text-fg/80">{e.memo}</dd>
    </div>
  {/if}
</dl>

<AuditHistory events={data.auditEvents} />
