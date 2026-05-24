<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const inv = $derived(data.invoice);
  const customer = $derived(data.customer);

  // Mirrors the API state machine: draft can be sent / paid / voided;
  // sent can be paid / voided; paid and voided are terminal. The buttons
  // disappear on terminal states so the UI doesn't tempt a 409 round-trip.
  const canMarkSent = $derived(inv.status === 'draft');
  const canMarkPaid = $derived(inv.status === 'draft' || inv.status === 'sent');
  const canVoid = $derived(inv.status === 'draft' || inv.status === 'sent');
  const hasActions = $derived(canMarkSent || canMarkPaid || canVoid);
</script>

<a href="/invoices" class="eyebrow text-ink/60 hover:text-ink">← Invoices</a>
<div class="mt-3 flex items-baseline justify-between gap-6">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-ink">
    Invoice {inv.number}<span class="text-gold-deep">.</span>
  </h1>
  <span class="font-mono text-xs uppercase tracking-widest text-ink/60">{inv.status}</span>
</div>

{#if form?.transitionError}
  <div class="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3 text-sm text-oxblood">
    {form.transitionError}
  </div>
{/if}

{#if hasActions}
  <div class="mt-6 flex flex-wrap items-center gap-3">
    {#if canMarkSent}
      <form method="post" action="?/markSent">
        <button
          type="submit"
          class="rounded-sm bg-ink px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
        >
          Mark sent
        </button>
      </form>
    {/if}
    {#if canMarkPaid}
      <form method="post" action="?/markPaid">
        <button
          type="submit"
          class="rounded-sm border border-ink/20 bg-cream-warm px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-gold-deep hover:text-gold-deep"
        >
          Mark paid
        </button>
      </form>
    {/if}
    {#if canVoid}
      <form method="post" action="?/void">
        <button
          type="submit"
          class="rounded-sm border border-oxblood/30 px-4 py-2 text-sm font-medium text-oxblood transition-colors hover:bg-oxblood/5"
        >
          Void
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
    <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Issued</dt>
    <dd class="mt-1 text-ink">{inv.issueDate}</dd>
  </div>
  <div>
    <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Due</dt>
    <dd class="mt-1 text-ink">{inv.dueDate}</dd>
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
      {#each inv.lineItems as li (li.id)}
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
        <td class="px-5 py-3 text-right font-mono tabular-nums text-ink">{inv.subtotal}</td>
      </tr>
      <tr>
        <td colspan="3" class="px-5 py-3 text-right font-mono text-xs uppercase tracking-widest text-ink/50">
          Tax
        </td>
        <td class="px-5 py-3 text-right font-mono tabular-nums text-ink">{inv.tax}</td>
      </tr>
      <tr>
        <td colspan="3" class="px-5 py-3 text-right font-mono text-xs uppercase tracking-widest text-ink/50">
          Total ({inv.currency})
        </td>
        <td class="px-5 py-3 text-right font-mono tabular-nums text-lg text-ink">{inv.total}</td>
      </tr>
    </tfoot>
  </table>
</div>

{#if inv.notes}
  <div class="mt-8">
    <h2 class="font-mono text-xs uppercase tracking-widest text-ink/50">Notes</h2>
    <p class="mt-2 whitespace-pre-wrap text-ink/80">{inv.notes}</p>
  </div>
{/if}
