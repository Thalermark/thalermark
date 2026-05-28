<script lang="ts">
  import AuditHistory from '$lib/components/AuditHistory.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const c = $derived(data.customer);

  const addressLines = $derived(
    [
      c.addressLine1,
      c.addressLine2,
      [c.city, c.region, c.postalCode].filter(Boolean).join(', ') || null,
      c.country,
    ].filter((line): line is string => Boolean(line)),
  );
</script>

<a href="/customers" class="eyebrow text-ink/60 hover:text-ink">← Customers</a>
<div class="mt-3 flex items-baseline justify-between gap-6">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-ink">
    {c.name}<span class="text-gold-deep">.</span>
  </h1>
  <a
    href="/customers/{c.id}/edit"
    class="rounded-sm border border-ink/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-ink/70 hover:border-gold-deep hover:text-gold-deep"
  >
    Edit
  </a>
</div>

<dl class="mt-8 grid grid-cols-1 gap-x-12 gap-y-6 sm:grid-cols-2">
  {#if c.email}
    <div>
      <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Email</dt>
      <dd class="mt-1 text-ink">{c.email}</dd>
    </div>
  {/if}
  {#if c.phone}
    <div>
      <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Phone</dt>
      <dd class="mt-1 text-ink">{c.phone}</dd>
    </div>
  {/if}
  {#if addressLines.length > 0}
    <div class="sm:col-span-2">
      <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Address</dt>
      <dd class="mt-1 text-ink">
        {#each addressLines as line, i (i)}
          <div>{line}</div>
        {/each}
      </dd>
    </div>
  {/if}
  {#if c.notes}
    <div class="sm:col-span-2">
      <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Notes</dt>
      <dd class="mt-1 whitespace-pre-wrap text-ink/80">{c.notes}</dd>
    </div>
  {/if}
</dl>

<AuditHistory events={data.auditEvents} />
