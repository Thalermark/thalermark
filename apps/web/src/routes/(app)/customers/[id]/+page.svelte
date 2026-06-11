<script lang="ts">
  import AuditHistory from '$lib/components/AuditHistory.svelte';
  import { may } from '$lib/perms';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const c = $derived(data.customer);

  // Role gate (UX only — the API is authoritative). Editing a customer is
  // `customers:write`; the statement is a read and stays open to every role.
  const canWrite = $derived(may(data.role, 'customers:write'));

  const addressLines = $derived(
    [
      c.addressLine1,
      c.addressLine2,
      [c.city, c.region, c.postalCode].filter(Boolean).join(', ') || null,
      c.country,
    ].filter((line): line is string => Boolean(line)),
  );

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  // Payment reliability (late-payer detection). Needs at least 2 paid invoices
  // to state a pattern; below that we only surface a live overdue warning, if
  // any. The headline + tone are derived from the deterministic API figures.
  const r = $derived(data.reliability);
  const reliability = $derived.by(() => {
    if (!r) return null;
    const overdue =
      r.overdueCount > 0
        ? `${r.overdueCount} invoice${r.overdueCount === 1 ? '' : 's'} overdue now (${fmt(r.overdueTotal)})`
        : null;
    if (r.paidCount < 2) {
      return overdue ? { headline: overdue, tone: 'warning' as const } : null;
    }
    if (r.lateCount === 0) {
      return { headline: `Always pays on time (${r.paidCount} invoices)`, tone: 'good' as const };
    }
    const days =
      r.avgDaysLate && r.avgDaysLate > 0
        ? ` — about ${r.avgDaysLate} ${r.avgDaysLate === 1 ? 'day' : 'days'} past due`
        : '';
    return {
      headline: `Pays late ${r.lateCount} of ${r.paidCount} times${days}`,
      tone: (r.latePct ?? 0) >= 50 ? ('warning' as const) : ('info' as const),
    };
  });

  const toneClass = (tone: string) =>
    tone === 'warning'
      ? 'border-oxblood/30 bg-oxblood/5'
      : tone === 'good'
        ? 'border-gold-deep/30 bg-gold-deep/5'
        : 'border-ink/15 bg-cream-warm';
</script>

<a href="/customers" class="eyebrow text-ink/60 hover:text-ink">← Customers</a>
<div class="mt-3 flex items-baseline justify-between gap-6">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-ink">
    {c.name}<span class="text-gold-deep">.</span>
  </h1>
  <div class="flex items-center gap-2">
    <a
      href="/customers/{c.id}/statement"
      class="rounded-sm border border-ink/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-ink/70 hover:border-gold-deep hover:text-gold-deep"
    >
      Statement
    </a>
    {#if canWrite}
      <a
        href="/customers/{c.id}/edit"
        class="rounded-sm border border-ink/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-ink/70 hover:border-gold-deep hover:text-gold-deep"
      >
        Edit
      </a>
    {/if}
  </div>
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

{#if reliability}
  <section class="mt-8">
    <h2 class="font-mono text-xs uppercase tracking-widest text-ink/50">Payment reliability</h2>
    <p class="mt-3 rounded-sm border px-4 py-3 text-sm text-ink/80 {toneClass(reliability.tone)}">
      {reliability.headline}
    </p>
    {#if r && r.paidCount >= 2 && r.overdueCount > 0}
      <p
        class="mt-2 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3 text-sm text-ink/80"
      >
        {r.overdueCount} invoice{r.overdueCount === 1 ? '' : 's'} overdue now ({fmt(r.overdueTotal)})
      </p>
    {/if}
  </section>
{/if}

<AuditHistory events={data.auditEvents} />
