<script lang="ts">
  import AuditHistory from '$lib/components/AuditHistory.svelte';
  import { cadenceLabel } from '$lib/recurring';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const s = $derived(data.schedule);
  const customer = $derived(data.customer);

  // Mirrors the API state machine. pause: active → paused; resume: paused →
  // active; end: active|paused → ended (terminal). run-now + edit are gated to
  // non-terminal states; ended schedules are read-only.
  const canPause = $derived(s.status === 'active');
  const canResume = $derived(s.status === 'paused');
  const canEnd = $derived(s.status === 'active' || s.status === 'paused');
  const canRunNow = $derived(s.status === 'active');
  const canEdit = $derived(s.status === 'active' || s.status === 'paused');
  const hasActions = $derived(canRunNow || canPause || canResume || canEnd);

  const endLabel = $derived(
    s.endDate
      ? `Ends ${s.endDate}`
      : s.maxOccurrences != null
        ? `Stops after ${s.maxOccurrences} invoice${s.maxOccurrences === 1 ? '' : 's'}`
        : 'Runs until paused or ended',
  );
</script>

<a href="/recurring" class="eyebrow text-ink/60 hover:text-ink">← Recurring</a>
<div class="mt-3 flex items-baseline justify-between gap-6">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-ink">
    Recurring schedule<span class="text-gold-deep">.</span>
  </h1>
  <div class="flex items-center gap-3">
    {#if canEdit}
      <a
        href="/recurring/{s.id}/edit"
        class="rounded-sm border border-ink/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-ink/70 hover:border-gold-deep hover:text-gold-deep"
      >
        Edit
      </a>
    {/if}
    <span class="font-mono text-xs uppercase tracking-widest text-ink/60">{s.status}</span>
  </div>
</div>

{#if form?.transitionError}
  <div class="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3 text-sm text-oxblood">
    {form.transitionError}
  </div>
{/if}

{#if data.ranInvoiceId}
  <div class="mt-6 rounded-sm border border-gold-deep/30 bg-gold-deep/5 px-4 py-3 text-sm text-ink">
    Invoice generated.
    <a href="/invoices/{data.ranInvoiceId}" class="font-medium text-gold-deep hover:underline">
      View it →
    </a>
  </div>
{/if}

{#if hasActions}
  <div class="mt-6 flex flex-wrap items-center gap-3">
    {#if canRunNow}
      <form method="post" action="?/runNow">
        <button
          type="submit"
          class="rounded-sm bg-ink px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
        >
          Generate next now
        </button>
      </form>
    {/if}
    {#if canPause}
      <form method="post" action="?/pause">
        <button
          type="submit"
          class="rounded-sm border border-ink/20 bg-cream-warm px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-gold-deep hover:text-gold-deep"
        >
          Pause
        </button>
      </form>
    {/if}
    {#if canResume}
      <form method="post" action="?/resume">
        <button
          type="submit"
          class="rounded-sm border border-ink/20 bg-cream-warm px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-gold-deep hover:text-gold-deep"
        >
          Resume
        </button>
      </form>
    {/if}
    {#if canEnd}
      <form method="post" action="?/end">
        <button
          type="submit"
          class="rounded-sm border border-oxblood/30 px-4 py-2 text-sm font-medium text-oxblood transition-colors hover:bg-oxblood/5"
        >
          End
        </button>
      </form>
    {/if}
  </div>
{/if}

<dl class="mt-8 grid grid-cols-1 gap-x-12 gap-y-6 sm:grid-cols-3">
  <div>
    <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Customer</dt>
    <dd class="mt-1 text-ink">
      {#if customer}
        <a href="/customers/{customer.id}" class="hover:text-gold-deep">{customer.name}</a>
      {:else}
        —
      {/if}
    </dd>
  </div>
  <div>
    <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Cadence</dt>
    <dd class="mt-1 text-ink">{cadenceLabel(s.frequency, s.intervalCount)}</dd>
  </div>
  <div>
    <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Next invoice</dt>
    <dd class="mt-1 font-mono tabular-nums text-ink">{s.status === 'ended' ? '—' : s.nextRunDate}</dd>
  </div>
  <div>
    <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Started</dt>
    <dd class="mt-1 font-mono tabular-nums text-ink">{s.startDate}</dd>
  </div>
  <div>
    <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Invoices sent</dt>
    <dd class="mt-1 font-mono tabular-nums text-ink">{s.occurrenceCount}</dd>
  </div>
  <div>
    <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Ends</dt>
    <dd class="mt-1 text-ink">{endLabel}</dd>
  </div>
</dl>

<div class="mt-10 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
  <table class="w-full text-left text-sm">
    <thead class="bg-cream">
      <tr class="font-mono text-xs uppercase tracking-widest text-ink/50">
        <th class="px-5 py-3">Description</th>
        <th class="px-5 py-3 text-right">Qty</th>
        <th class="px-5 py-3 text-right">Unit price</th>
        <th class="px-5 py-3 text-right">Amount</th>
      </tr>
    </thead>
    <tbody class="divide-y divide-ink/10">
      {#each s.lineItems as li (li.id)}
        <tr>
          <td class="px-5 py-4 text-ink">{li.description}</td>
          <td class="px-5 py-4 text-right font-mono tabular-nums text-ink/80">{li.quantity}</td>
          <td class="px-5 py-4 text-right font-mono tabular-nums text-ink/80">{li.unitPrice}</td>
          <td class="px-5 py-4 text-right font-mono tabular-nums text-ink">{li.amount}</td>
        </tr>
      {/each}
    </tbody>
    <tfoot class="bg-cream">
      <tr>
        <td colspan="3" class="px-5 py-3 text-right font-mono text-xs uppercase tracking-widest text-ink/50">
          Subtotal
        </td>
        <td class="px-5 py-3 text-right font-mono tabular-nums text-ink">{s.subtotal}</td>
      </tr>
      <tr>
        <td colspan="3" class="px-5 py-3 text-right font-mono text-xs uppercase tracking-widest text-ink/50">
          Tax
        </td>
        <td class="px-5 py-3 text-right font-mono tabular-nums text-ink">{s.tax}</td>
      </tr>
      <tr>
        <td colspan="3" class="px-5 py-3 text-right font-mono text-xs uppercase tracking-widest text-ink/50">
          Total per invoice ({s.currency})
        </td>
        <td class="px-5 py-3 text-right font-mono tabular-nums text-lg text-ink">{s.total}</td>
      </tr>
    </tfoot>
  </table>
</div>

{#if s.notes}
  <div class="mt-8">
    <h2 class="font-mono text-xs uppercase tracking-widest text-ink/50">Notes</h2>
    <p class="mt-2 whitespace-pre-wrap text-ink/80">{s.notes}</p>
  </div>
{/if}

<div class="mt-10">
  <h2 class="font-mono text-xs uppercase tracking-widest text-ink/50">Generated invoices</h2>
  {#if s.generatedInvoices.length === 0}
    <p class="mt-2 text-sm text-ink/60">None yet.</p>
  {:else}
    <div class="mt-3 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
      <table class="w-full text-left text-sm">
        <thead class="bg-cream">
          <tr class="font-mono text-xs uppercase tracking-widest text-ink/50">
            <th class="px-5 py-3">Number</th>
            <th class="px-5 py-3">Issued</th>
            <th class="px-5 py-3">Status</th>
            <th class="px-5 py-3 text-right">Total</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-ink/10">
          {#each s.generatedInvoices as inv (inv.id)}
            <tr class="hover:bg-cream">
              <td class="px-5 py-4">
                <a href="/invoices/{inv.id}" class="font-serif text-ink hover:text-gold-deep">
                  {inv.number}
                </a>
              </td>
              <td class="px-5 py-4 font-mono tabular-nums text-ink/80">{inv.issueDate}</td>
              <td class="px-5 py-4">
                <span class="font-mono text-xs uppercase tracking-widest text-ink/60">
                  {inv.status}
                </span>
              </td>
              <td class="px-5 py-4 text-right font-mono tabular-nums text-ink">{inv.total}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<AuditHistory events={data.auditEvents} />
