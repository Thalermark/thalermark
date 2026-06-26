<script lang="ts">
  import AuditHistory from '$lib/components/AuditHistory.svelte';
  import PaymentFields from '$lib/components/PaymentFields.svelte';
  import { may } from '$lib/perms';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const bill = $derived(data.bill);
  const canWrite = $derived(may(data.role, 'expenses:write'));
  const isOpen = $derived(bill.status === 'open');

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  function statusClass(status: string): string {
    return status === 'paid'
      ? 'bg-accent/15 text-accent'
      : status === 'voided'
        ? 'bg-fg/10 text-fg/50'
        : 'bg-warning/15 text-warning';
  }

  let showPay = $state(false);
</script>

<a href="/bills" class="eyebrow text-fg/60 hover:text-fg">← Bills</a>

<div class="mt-3 flex flex-wrap items-baseline justify-between gap-4">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
    {bill.vendorName}<span class="text-accent">.</span>
  </h1>
  <span
    class="rounded-sm px-2.5 py-1 text-xs font-medium uppercase tracking-wide {statusClass(
      bill.status,
    )}"
  >
    {bill.status}
  </span>
</div>

{#if form?.transitionError}
  <p class="callout mt-6 border-danger/30 bg-danger/5 text-danger">{form.transitionError}</p>
{/if}

<dl class="mt-8 grid max-w-2xl grid-cols-1 gap-x-10 gap-y-5 sm:grid-cols-2">
  <div>
    <dt class="label">Amount</dt>
    <dd class="mt-1 font-serif text-2xl font-light tabular-nums text-fg">{fmt(bill.amount)}</dd>
  </div>
  <div>
    <dt class="label">Category</dt>
    <dd class="mt-1 text-sm text-fg/80">{data.categoryLabel}</dd>
  </div>
  <div>
    <dt class="label">Bill date</dt>
    <dd class="mt-1 font-mono tabular-nums text-sm text-fg/80">{bill.billDate}</dd>
  </div>
  <div>
    <dt class="label">Due date</dt>
    <dd class="mt-1 font-mono tabular-nums text-sm text-fg/80">{bill.dueDate}</dd>
  </div>
  {#if bill.reference}
    <div>
      <dt class="label">Reference</dt>
      <dd class="mt-1 font-mono text-sm text-fg/80">#{bill.reference}</dd>
    </div>
  {/if}
  {#if bill.memo}
    <div class="sm:col-span-2">
      <dt class="label">Memo</dt>
      <dd class="mt-1 whitespace-pre-line text-sm text-fg/80">{bill.memo}</dd>
    </div>
  {/if}
</dl>

{#if bill.status === 'paid'}
  <div class="mt-8 max-w-2xl rounded-sm border border-accent/30 bg-accent/5 p-5">
    <p class="label">Paid</p>
    <dl class="mt-2 grid grid-cols-1 gap-x-10 gap-y-2 text-sm text-fg/80 sm:grid-cols-2">
      <div><span class="text-fg/50">Method:</span> {bill.paymentMethod}</div>
      {#if bill.paymentReference}
        <div><span class="text-fg/50">Reference:</span> {bill.paymentReference}</div>
      {/if}
      {#if bill.paidAt}
        <div><span class="text-fg/50">On:</span> {bill.paidAt.slice(0, 10)}</div>
      {/if}
      {#if data.paymentLabel}
        <div><span class="text-fg/50">From:</span> {data.paymentLabel}</div>
      {/if}
    </dl>
  </div>
{/if}

{#if canWrite && isOpen}
  <div class="mt-8 flex flex-wrap items-center gap-4">
    <button type="button" class="btn" onclick={() => (showPay = !showPay)}>Mark paid</button>
    <a href="/bills/{bill.id}/edit" class="text-sm text-fg/70 hover:text-fg">Edit</a>
    <form method="POST" action="?/void">
      <button
        type="submit"
        class="text-sm text-fg/50 hover:text-danger"
        onclick={(e) => {
          if (!confirm('Void this bill? This reverses its ledger entry.')) e.preventDefault();
        }}
      >
        Void
      </button>
    </form>
  </div>

  {#if showPay}
    <form method="POST" action="?/markPaid" class="mt-6 max-w-xl rounded-sm border border-fg/10 bg-surface-2 p-5">
      <PaymentFields />
      <div class="mt-5 flex items-center gap-4">
        <button type="submit" class="btn">Record payment</button>
        <button type="button" class="text-sm text-fg/60 hover:text-fg" onclick={() => (showPay = false)}>
          Cancel
        </button>
      </div>
    </form>
  {/if}
{/if}

<div class="mt-12 max-w-2xl">
  <AuditHistory events={data.auditEvents} />
</div>
