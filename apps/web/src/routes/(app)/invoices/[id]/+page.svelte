<script lang="ts">
  import AuditHistory from '$lib/components/AuditHistory.svelte';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const inv = $derived(data.invoice);
  const customer = $derived(data.customer);

  // Mirrors the API state machine: draft can be sent / paid / voided;
  // sent can be paid / voided; paid and voided are terminal. The buttons
  // disappear on terminal states so the UI doesn't tempt a 409 round-trip.
  // canSend covers both first-send (draft → sent + email) and resend
  // (sent → email only); the API handles the dispatch.
  const canSend = $derived(inv.status === 'draft' || inv.status === 'sent');
  const canMarkSent = $derived(inv.status === 'draft');
  const canMarkPaid = $derived(inv.status === 'draft' || inv.status === 'sent');
  const canVoid = $derived(inv.status === 'draft' || inv.status === 'sent');
  // Edit gate matches the API's draft-only rule — once sent/paid/voided the
  // invoice belongs to the audit trail, not the editor.
  const canEdit = $derived(inv.status === 'draft');
  const hasActions = $derived(canSend || canMarkSent || canMarkPaid || canVoid);

  // Public share URL is available once mark-sent mints the token. Built
  // server-side off event.url.origin so it works behind any proxy. Shown
  // alongside the email send so the user can also share the link directly.
  const publicUrl = $derived(inv.publicToken ? `${data.origin}/i/${inv.publicToken}` : null);

  // Send-form state: collapsed `to` override field, opens on a click.
  // Default `to` mirrors the customer's email when available.
  let showOverride = $state(false);
  const sendLabel = $derived(inv.status === 'sent' ? 'Resend invoice' : 'Send invoice');
</script>

<a href="/invoices" class="eyebrow text-ink/60 hover:text-ink">← Invoices</a>
<div class="mt-3 flex items-baseline justify-between gap-6">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-ink">
    Invoice {inv.number}<span class="text-gold-deep">.</span>
  </h1>
  <div class="flex items-center gap-3">
    {#if canEdit}
      <a
        href="/invoices/{inv.id}/edit"
        class="rounded-sm border border-ink/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-ink/70 hover:border-gold-deep hover:text-gold-deep"
      >
        Edit
      </a>
    {/if}
    <!-- Duplicate-as-template: available for any status (a paid/sent invoice is
         a common template). Posts to ?/duplicate → new draft's edit page. -->
    <form method="post" action="?/duplicate">
      <button
        type="submit"
        class="rounded-sm border border-ink/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-ink/70 hover:border-gold-deep hover:text-gold-deep"
      >
        Duplicate
      </button>
    </form>
    <span class="font-mono text-xs uppercase tracking-widest text-ink/60">{inv.status}</span>
  </div>
</div>

{#if form?.transitionError}
  <div class="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3 text-sm text-oxblood">
    {form.transitionError}
  </div>
{/if}

{#if data.sentTo}
  <div class="mt-6 rounded-sm border border-gold-deep/30 bg-gold-deep/5 px-4 py-3 text-sm text-ink">
    Sent to <span class="font-medium">{data.sentTo}</span>.
  </div>
{/if}

{#if hasActions}
  <div class="mt-6 flex flex-wrap items-center gap-3">
    {#if canSend}
      <form method="post" action="?/send" class="flex flex-wrap items-center gap-2">
        {#if showOverride}
          <input
            type="email"
            name="to"
            placeholder={customer?.email ?? 'recipient@example.com'}
            class="rounded-sm border border-ink/20 bg-cream-warm px-3 py-2 text-sm text-ink placeholder:text-ink/40 focus:border-gold-deep focus:outline-none"
          />
        {/if}
        <button
          type="submit"
          class="rounded-sm bg-ink px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
        >
          {sendLabel}
        </button>
        {#if !showOverride}
          <button
            type="button"
            onclick={() => {
              showOverride = true;
            }}
            class="text-xs uppercase tracking-widest text-ink/50 hover:text-gold-deep"
          >
            Send to another address
          </button>
        {/if}
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
  {#if canMarkSent}
    <form method="post" action="?/markSent" class="mt-2">
      <button
        type="submit"
        class="text-xs uppercase tracking-widest text-ink/50 hover:text-gold-deep"
      >
        Mark sent without email
      </button>
    </form>
  {/if}
{/if}

{#if publicUrl}
  <div class="mt-6 rounded-sm border border-ink/10 bg-cream-warm p-4">
    <p class="font-mono text-xs uppercase tracking-widest text-ink/50">Share link</p>
    <div class="mt-2 flex flex-wrap items-center gap-3 text-sm">
      <a href={publicUrl} target="_blank" rel="noopener" class="break-all text-gold-deep hover:underline">
        {publicUrl}
      </a>
    </div>
    <p class="mt-2 text-xs text-ink/50">
      Anyone with this link can view the invoice.
    </p>
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

<AuditHistory events={data.auditEvents} />
