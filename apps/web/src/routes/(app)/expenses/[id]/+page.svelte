<script lang="ts">
  import AuditHistory from '$lib/components/AuditHistory.svelte';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const e = $derived(data.expense);
</script>

<a href="/expenses" class="eyebrow text-ink/60 hover:text-ink">← Expenses</a>
<div class="mt-3 flex items-baseline justify-between gap-6">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-ink">
    {e.merchant}<span class="text-gold-deep">.</span>
  </h1>
  <div class="flex items-center gap-3">
    <a
      href="/expenses/{e.id}/edit"
      class="rounded-sm border border-ink/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-ink/70 hover:border-gold-deep hover:text-gold-deep"
    >
      Edit
    </a>
    <form method="post" action="?/delete">
      <button
        type="submit"
        class="rounded-sm border border-oxblood/30 px-3 py-1 font-mono text-xs uppercase tracking-widest text-oxblood/80 hover:border-oxblood hover:text-oxblood"
      >
        Delete
      </button>
    </form>
  </div>
</div>

{#if form?.deleteError}
  <div class="mt-4 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3 text-sm text-oxblood">
    Could not delete this expense: {form.deleteError}
  </div>
{/if}

<dl class="mt-8 grid grid-cols-1 gap-x-12 gap-y-6 sm:grid-cols-2">
  <div>
    <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Amount</dt>
    <dd class="mt-1 font-mono tabular-nums text-ink">{e.amount}</dd>
  </div>
  <div>
    <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Date</dt>
    <dd class="mt-1 font-mono tabular-nums text-ink">{e.expenseDate}</dd>
  </div>
  <div>
    <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Category</dt>
    <dd class="mt-1 text-ink">{data.categoryLabel}</dd>
  </div>
  <div>
    <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Paid from</dt>
    <dd class="mt-1 text-ink">{data.paymentLabel}</dd>
  </div>
  <div>
    <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Receipt</dt>
    <dd class="mt-1 text-ink/80">{e.receiptStorageKey ? 'Attached' : 'None'}</dd>
  </div>
  {#if e.memo}
    <div class="sm:col-span-2">
      <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Memo</dt>
      <dd class="mt-1 whitespace-pre-wrap text-ink/80">{e.memo}</dd>
    </div>
  {/if}
</dl>

<AuditHistory events={data.auditEvents} />
