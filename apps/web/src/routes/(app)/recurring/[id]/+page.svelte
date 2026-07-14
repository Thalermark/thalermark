<script lang="ts">
  import AuditHistory from '$lib/components/AuditHistory.svelte';
  import { may } from '$lib/perms';
  import { cadenceLabel } from '$lib/recurring';
  import { formatUnitPrice } from '@thalermark/validation';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const s = $derived(data.schedule);
  const contact = $derived(data.contact);

  // Role gate (UX only — the API is authoritative). Recurring writes and state
  // actions are `sales:write`; each status gate is ANDed with it.
  const canWrite = $derived(may(data.role, 'sales:write'));

  // Mirrors the API state machine. pause: active → paused; resume: paused →
  // active; end: active|paused → ended (terminal). run-now + edit are gated to
  // non-terminal states; ended schedules are read-only.
  const canPause = $derived(canWrite && s.status === 'active');
  const canResume = $derived(canWrite && s.status === 'paused');
  const canEnd = $derived(canWrite && (s.status === 'active' || s.status === 'paused'));
  const canRunNow = $derived(canWrite && s.status === 'active');
  const canEdit = $derived(canWrite && (s.status === 'active' || s.status === 'paused'));
  const hasActions = $derived(canRunNow || canPause || canResume || canEnd);

  const endLabel = $derived(
    s.endDate
      ? `Ends ${s.endDate}`
      : s.maxOccurrences != null
        ? `Stops after ${s.maxOccurrences} invoice${s.maxOccurrences === 1 ? '' : 's'}`
        : 'Runs until paused or ended',
  );
</script>

<a href="/recurring" class="eyebrow text-fg/60 hover:text-fg">← Recurring</a>
<div class="mt-3 flex items-baseline justify-between gap-6">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
    Recurring schedule<span class="text-accent">.</span>
  </h1>
  <div class="flex items-center gap-3">
    {#if canEdit}
      <a
        href="/recurring/{s.id}/edit"
        class="rounded-sm border border-fg/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70 hover:border-accent hover:text-accent"
      >
        Edit
      </a>
    {/if}
    <span class="font-mono text-xs uppercase tracking-widest text-fg/60">{s.status}</span>
  </div>
</div>

{#if form?.transitionError}
  <div class="mt-6 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    {form.transitionError}
  </div>
{/if}

{#if data.ranInvoiceId}
  <div class="mt-6 rounded-sm border border-accent/30 bg-accent/5 px-4 py-3 text-sm text-fg">
    Invoice generated.
    <a href="/invoices/{data.ranInvoiceId}" class="font-medium text-accent hover:underline">
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
          class="btn"
        >
          Generate next now
        </button>
      </form>
    {/if}
    {#if canPause}
      <form method="post" action="?/pause">
        <button
          type="submit"
          class="btn-ghost bg-surface-2"
        >
          Pause
        </button>
      </form>
    {/if}
    {#if canResume}
      <form method="post" action="?/resume">
        <button
          type="submit"
          class="btn-ghost bg-surface-2"
        >
          Resume
        </button>
      </form>
    {/if}
    {#if canEnd}
      <form method="post" action="?/end">
        <button
          type="submit"
          class="rounded-sm border border-danger/30 px-4 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger/5"
        >
          End
        </button>
      </form>
    {/if}
  </div>
{/if}

<dl class="mt-8 grid grid-cols-1 gap-x-12 gap-y-6 sm:grid-cols-3">
  <div>
    <dt class="label">Contact</dt>
    <dd class="mt-1 text-fg">
      {#if contact}
        <a href="/contacts/{contact.id}" class="hover:text-accent">{contact.name}</a>
      {:else}
        —
      {/if}
    </dd>
  </div>
  <div>
    <dt class="label">Cadence</dt>
    <dd class="mt-1 text-fg">{cadenceLabel(s.frequency, s.intervalCount)}</dd>
  </div>
  <div>
    <dt class="label">Next invoice</dt>
    <dd class="mt-1 font-mono tabular-nums text-fg">{s.status === 'ended' ? '—' : s.nextRunDate}</dd>
  </div>
  <div>
    <dt class="label">Started</dt>
    <dd class="mt-1 font-mono tabular-nums text-fg">{s.startDate}</dd>
  </div>
  <div>
    <dt class="label">Invoices sent</dt>
    <dd class="mt-1 font-mono tabular-nums text-fg">{s.occurrenceCount}</dd>
  </div>
  <div>
    <dt class="label">Ends</dt>
    <dd class="mt-1 text-fg">{endLabel}</dd>
  </div>
</dl>

<div class="mt-10 overflow-hidden rounded-sm border border-fg/10 bg-surface-2">
  <table class="w-full text-left text-sm">
    <thead class="bg-surface">
      <tr class="label">
        <th class="px-5 py-3">Description</th>
        <th class="px-5 py-3 text-right">Qty</th>
        <th class="px-5 py-3 text-right">Unit price</th>
        <th class="px-5 py-3 text-right">Amount</th>
      </tr>
    </thead>
    <tbody class="divide-y divide-fg/10">
      {#each s.lineItems as li (li.id)}
        <tr>
          <td class="px-5 py-4 text-fg">{li.description}</td>
          <td class="px-5 py-4 text-right font-mono tabular-nums text-fg/80">{li.quantity}</td>
          <td class="px-5 py-4 text-right font-mono tabular-nums text-fg/80">{formatUnitPrice(li.unitPrice)}</td>
          <td class="px-5 py-4 text-right font-mono tabular-nums text-fg">{li.amount}</td>
        </tr>
      {/each}
    </tbody>
    <tfoot class="bg-surface">
      <tr>
        <td colspan="3" class="px-5 py-3 text-right label">
          Subtotal
        </td>
        <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">{s.subtotal}</td>
      </tr>
      <tr>
        <td colspan="3" class="px-5 py-3 text-right label">
          Tax
        </td>
        <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">{s.tax}</td>
      </tr>
      <tr>
        <td colspan="3" class="px-5 py-3 text-right label">
          Total per invoice ({s.currency})
        </td>
        <td class="px-5 py-3 text-right font-mono tabular-nums text-lg text-fg">{s.total}</td>
      </tr>
    </tfoot>
  </table>
</div>

{#if s.notes}
  <div class="mt-8">
    <h2 class="label">Notes</h2>
    <p class="mt-2 whitespace-pre-wrap text-fg/80">{s.notes}</p>
  </div>
{/if}

<div class="mt-10">
  <h2 class="label">Generated invoices</h2>
  {#if s.generatedInvoices.length === 0}
    <p class="mt-2 text-sm text-fg/60">None yet.</p>
  {:else}
    <div class="mt-3 overflow-hidden rounded-sm border border-fg/10 bg-surface-2">
      <table class="w-full text-left text-sm">
        <thead class="bg-surface">
          <tr class="label">
            <th class="px-5 py-3">Number</th>
            <th class="px-5 py-3">Issued</th>
            <th class="px-5 py-3">Status</th>
            <th class="px-5 py-3 text-right">Total</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-fg/10">
          {#each s.generatedInvoices as inv (inv.id)}
            <tr class="hover:bg-surface">
              <td class="px-5 py-4">
                <a href="/invoices/{inv.id}" class="font-serif text-fg hover:text-accent">
                  {inv.number}
                </a>
              </td>
              <td class="px-5 py-4 font-mono tabular-nums text-fg/80">{inv.issueDate}</td>
              <td class="px-5 py-4">
                <span class="font-mono text-xs uppercase tracking-widest text-fg/60">
                  {inv.status}
                </span>
              </td>
              <td class="px-5 py-4 text-right font-mono tabular-nums text-fg">{inv.total}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<AuditHistory events={data.auditEvents} />
