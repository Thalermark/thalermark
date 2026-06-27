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

  // "Taxable · General 8.25%" / "Taxable · Company default" / "Not taxable".
  const taxLabel = $derived.by(() => {
    if (!item.taxable) return 'Not taxable';
    const p = data.taxPolicy;
    return p ? `Taxable · ${p.name} ${Number(p.ratePct)}%` : 'Taxable · Company default';
  });
</script>

<a href="/items" class="eyebrow text-fg/60 hover:text-fg">← Items</a>
<div class="mt-3 flex items-baseline justify-between gap-6">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
    {item.name}<span class="text-accent">.</span>
    {#if archived}
      <span
        class="ml-2 align-middle rounded-sm border border-fg/15 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-widest text-fg/50"
      >
        Archived
      </span>
    {/if}
  </h1>
  {#if canWrite}
    <div class="flex items-center gap-2">
      <a
        href="/items/{item.id}/edit"
        class="rounded-sm border border-fg/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70 hover:border-accent hover:text-accent"
      >
        Edit
      </a>
      <form method="post" action={archived ? '?/restore' : '?/archive'}>
        <button
          type="submit"
          class="rounded-sm border border-fg/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70 hover:border-accent hover:text-accent"
        >
          {archived ? 'Restore' : 'Archive'}
        </button>
      </form>
    </div>
  {/if}
</div>

{#if archived}
  <p class="mt-6 rounded-sm border border-fg/15 bg-surface-2 px-4 py-3 text-sm text-fg/70">
    This item is archived — it won't appear in the line-item picker. Its sales history is kept.
  </p>
{/if}

<dl class="mt-8 grid grid-cols-1 gap-x-12 gap-y-6 sm:grid-cols-2">
  <div>
    <dt class="label">Type</dt>
    <dd class="mt-1 text-fg">{item.type === 'product' ? 'Product' : 'Service'}</dd>
  </div>
  <div>
    <dt class="label">Unit price</dt>
    <dd class="mt-1 text-fg">
      {fmt(item.unitPrice)}{#if item.unitLabel}<span class="text-fg/50"> / {item.unitLabel}</span>{/if}
    </dd>
  </div>
  <div>
    <dt class="label">Default quantity</dt>
    <dd class="mt-1 text-fg">{qty(item.defaultQuantity)}</dd>
  </div>
  <div>
    <dt class="label">Tax</dt>
    <dd class="mt-1 text-fg">{taxLabel}</dd>
  </div>
  {#if item.description}
    <div class="sm:col-span-2">
      <dt class="label">Description</dt>
      <dd class="mt-1 whitespace-pre-wrap text-fg/80">{item.description}</dd>
    </div>
  {/if}
</dl>

<AuditHistory events={data.auditEvents} />
