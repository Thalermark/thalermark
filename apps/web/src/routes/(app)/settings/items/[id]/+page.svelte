<script lang="ts">
  import AuditHistory from '$lib/components/AuditHistory.svelte';
  import { may } from '$lib/perms';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const item = $derived(data.item);
  const archived = $derived(item.archivedAt !== null);

  // Role gate (UX only — the API is authoritative). The items catalog is part
  // of `sales:write` (it feeds invoices/estimates), so the same roles that can
  // invoice can edit and archive items.
  const canWrite = $derived(may(data.role, 'sales:write'));

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  // Trailing zeros from numeric(15,4) read oddly for a quantity ("2.5000");
  // strip them for display while leaving the stored value untouched.
  const qty = (s: string) => String(Number(s));
</script>

<a href="/settings/items" class="eyebrow text-ink/60 hover:text-ink">← Items</a>
<div class="mt-3 flex items-baseline justify-between gap-6">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-ink">
    {item.name}<span class="text-gold-deep">.</span>
    {#if archived}
      <span
        class="ml-2 align-middle rounded-sm border border-ink/15 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-widest text-ink/50"
      >
        Archived
      </span>
    {/if}
  </h1>
  {#if canWrite}
    <div class="flex items-center gap-2">
      <a
        href="/settings/items/{item.id}/edit"
        class="rounded-sm border border-ink/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-ink/70 hover:border-gold-deep hover:text-gold-deep"
      >
        Edit
      </a>
      <form method="post" action={archived ? '?/restore' : '?/archive'}>
        <button
          type="submit"
          class="rounded-sm border border-ink/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-ink/70 hover:border-gold-deep hover:text-gold-deep"
        >
          {archived ? 'Restore' : 'Archive'}
        </button>
      </form>
    </div>
  {/if}
</div>

{#if archived}
  <p class="mt-6 rounded-sm border border-ink/15 bg-cream-warm px-4 py-3 text-sm text-ink/70">
    This item is archived — it won't appear in the line-item picker. Its sales history is kept.
  </p>
{/if}

<dl class="mt-8 grid grid-cols-1 gap-x-12 gap-y-6 sm:grid-cols-2">
  <div>
    <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Unit price</dt>
    <dd class="mt-1 text-ink">
      {fmt(item.unitPrice)}{#if item.unitLabel}<span class="text-ink/50"> / {item.unitLabel}</span>{/if}
    </dd>
  </div>
  <div>
    <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Default quantity</dt>
    <dd class="mt-1 text-ink">{qty(item.defaultQuantity)}</dd>
  </div>
  {#if item.description}
    <div class="sm:col-span-2">
      <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Description</dt>
      <dd class="mt-1 whitespace-pre-wrap text-ink/80">{item.description}</dd>
    </div>
  {/if}
</dl>

<AuditHistory events={data.auditEvents} />
