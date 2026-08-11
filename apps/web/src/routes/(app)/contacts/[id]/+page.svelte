<script lang="ts">
  import AuditHistory from '$lib/components/AuditHistory.svelte';
  import { may } from '$lib/perms';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const c = $derived(data.contact);

  // Role gate (UX only — the API is authoritative). Editing a contact is
  // `contacts:write`; the statement is a read and stays open to every role.
  const canWrite = $derived(may(data.role, 'contacts:write'));

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
      ? 'border-danger/30 bg-danger/5'
      : tone === 'good'
        ? 'border-accent/30 bg-accent/5'
        : 'border-fg/15 bg-surface-2';
</script>

<a href="/contacts" class="eyebrow text-fg/60 hover:text-fg">← Contacts</a>
<div class="mt-3 flex items-baseline justify-between gap-6">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
    {c.name}<span class="text-accent">.</span>
  </h1>
  <div class="flex items-center gap-2">
    <a
      href="/contacts/{c.id}/statement"
      class="rounded-sm border border-fg/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70 hover:border-accent hover:text-accent"
    >
      Statement
    </a>
    {#if canWrite}
      <a
        href="/contacts/{c.id}/edit"
        class="rounded-sm border border-fg/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70 hover:border-accent hover:text-accent"
      >
        Edit
      </a>
      <!--
        Archive, not delete. There is no delete: an invoice keeps naming who it
        was billed to, so a contact with any history can never go away. This
        takes the name out of the pickers and nothing else, and the button that
        replaces it puts it straight back.
      -->
      <form method="post" action={c.archivedAt ? '?/restore' : '?/archive'}>
        <button
          type="submit"
          class="rounded-sm border border-fg/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70 hover:border-accent hover:text-accent"
        >
          {c.archivedAt ? 'Restore' : 'Archive'}
        </button>
      </form>
    {/if}
  </div>
</div>

{#if c.archivedAt}
  <p class="mt-4 rounded-sm border border-fg/15 bg-surface-2 px-4 py-3 text-sm text-fg/70">
    Archived — hidden from the customer and vendor pickers. Existing invoices,
    estimates and expenses are untouched and still name them.
  </p>
{/if}

<dl class="mt-8 grid grid-cols-1 gap-x-12 gap-y-6 sm:grid-cols-2">
  {#if c.email}
    <div>
      <dt class="label">Email</dt>
      <dd class="mt-1 text-fg">{c.email}</dd>
    </div>
  {/if}
  {#if c.phone}
    <div>
      <dt class="label">Phone</dt>
      <dd class="mt-1 text-fg">{c.phone}</dd>
    </div>
  {/if}
  {#if addressLines.length > 0}
    <div class="sm:col-span-2">
      <dt class="label">Address</dt>
      <dd class="mt-1 text-fg">
        {#each addressLines as line, i (i)}
          <div>{line}</div>
        {/each}
      </dd>
    </div>
  {/if}
  {#if c.notes}
    <div class="sm:col-span-2">
      <dt class="label">Notes</dt>
      <dd class="mt-1 whitespace-pre-wrap text-fg/80">{c.notes}</dd>
    </div>
  {/if}
</dl>

{#if reliability}
  <section class="mt-8">
    <h2 class="label">Payment reliability</h2>
    <p class="mt-3 rounded-sm border px-4 py-3 text-sm text-fg/80 {toneClass(reliability.tone)}">
      {reliability.headline}
    </p>
    {#if r && r.paidCount >= 2 && r.overdueCount > 0}
      <p
        class="mt-2 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-fg/80"
      >
        {r.overdueCount} invoice{r.overdueCount === 1 ? '' : 's'} overdue now ({fmt(r.overdueTotal)})
      </p>
    {/if}
  </section>
{/if}

<AuditHistory events={data.auditEvents} />
