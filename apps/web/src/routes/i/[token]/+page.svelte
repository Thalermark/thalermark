<script lang="ts">
  import { page } from '$app/state';
  import { formatUnitPrice } from '@thalermark/validation';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const inv = $derived(data.invoice);

  // Stripe returns the customer here after /pay, appending redirect_status (and
  // payment_intent*) to our ?paid=1 marker. It appends those on FAILURE too, so
  // reading ?paid=1 alone told someone whose card was declined "Payment
  // received" and stopped the business chasing an invoice that was never paid
  // (TMC-211). The banner now says only what Stripe actually reported.
  //
  // The webhook usually beats the redirect, in which case inv.status is already
  // 'paid' and the settled banner below wins — this is the fallback for the
  // race, and now also the failure path.
  type PayOutcome = 'succeeded' | 'processing' | 'failed' | 'unknown';
  const payOutcome = $derived.by<PayOutcome | null>(() => {
    if (page.url.searchParams.get('paid') !== '1') return null;
    switch (page.url.searchParams.get('redirect_status')) {
      case 'succeeded':
        return 'succeeded';
      case 'processing':
        return 'processing';
      case 'failed':
      case 'requires_payment_method':
        return 'failed';
      // Stripe always appends redirect_status, so a missing one means the URL
      // was truncated or hand-edited. Claim nothing in either direction.
      default:
        return 'unknown';
    }
  });

  // Any money received against this invoice, so the recipient can see their
  // deposit landed instead of being shown the untouched total (TMC-210).
  const hasPaid = $derived(Number(inv.paid) > 0);

  // Flatten the enabled offline methods into a render-ready list. Empty when
  // none are configured (or the invoice is closed — the API nulls the block
  // then), which collapses the whole "or pay directly" section.
  const offlineMethods = $derived.by(() => {
    const o = inv.offlinePayment;
    if (!o) return [];
    const out: { label: string; value: string }[] = [];
    if (o.venmo) out.push({ label: 'Venmo', value: o.venmo });
    if (o.zelle) out.push({ label: 'Zelle', value: o.zelle });
    if (o.check) {
      const parts: string[] = [];
      if (o.check.payableTo) parts.push(`Payable to ${o.check.payableTo}`);
      if (o.check.address) parts.push(o.check.address);
      out.push({ label: 'Check', value: parts.join('\n') || 'By check' });
    }
    if (o.cash) out.push({ label: 'Cash', value: 'In person' });
    return out;
  });
</script>

<div class="mx-auto max-w-3xl px-6 py-12 sm:py-20">
  <header class="flex flex-wrap items-start justify-between gap-6 border-b border-fg/10 pb-8">
    <div>
      {#if inv.companyLogoUrl}
        <img
          src={inv.companyLogoUrl}
          alt={inv.companyName ?? 'Business logo'}
          class="mb-3 max-h-16 max-w-[12rem] object-contain"
        />
      {/if}
      <p class="eyebrow text-fg/50">{inv.companyName ?? 'Invoice'}</p>
      <h1 class="mt-2 font-serif text-4xl font-light leading-none tracking-tight text-fg">
        Invoice {inv.number}<span class="text-accent">.</span>
      </h1>
    </div>
    <span
      class="rounded-sm border border-fg/15 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70"
    >
      {inv.status}
    </span>
  </header>

  {#if inv.status === 'paid'}
    <div
      class="mt-6 rounded-sm border border-success/30 bg-success/5 px-4 py-3 text-sm text-success"
    >
      Paid{#if inv.paidAt} on {inv.paidAt.slice(0, 10)}{/if}. Thank you.
    </div>
  {:else if inv.status === 'voided'}
    <div class="mt-6 rounded-sm border border-fg/20 bg-surface-2 px-4 py-3 text-sm text-fg/70">
      This invoice has been voided.
    </div>
  {:else if payOutcome === 'failed'}
    <div class="mt-6 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-fg">
      That payment didn't go through, so nothing was charged. You can try again below, or pay by
      another method if one is listed.
      {#if inv.payable}
        <a class="link mt-2 block" href="/pay/{page.params.token}">Try again</a>
      {/if}
    </div>
  {:else if payOutcome === 'succeeded'}
    <div class="mt-6 rounded-sm border border-accent/30 bg-accent/5 px-4 py-3 text-sm text-fg">
      Payment received — finalizing. Refresh in a moment if this banner doesn't update.
    </div>
  {:else if payOutcome === 'processing'}
    <div class="mt-6 rounded-sm border border-accent/30 bg-accent/5 px-4 py-3 text-sm text-fg">
      Payment submitted and still clearing with your bank. This can take a few minutes — the
      invoice updates on its own once it settles.
    </div>
  {:else if payOutcome === 'unknown'}
    <div class="mt-6 rounded-sm border border-fg/15 bg-surface-2 px-4 py-3 text-sm text-fg/80">
      We're still confirming this payment. Refresh in a moment — the invoice shows as paid once
      it clears.
    </div>
  {:else if inv.noPaymentMethod}
    <!--
      Shown only when this page offers no way to pay at all — no card, no cash,
      no check, no Venmo, no Zelle. It says what the recipient can do and
      nothing about why: a customer should never be shown their supplier's
      unfinished payment setup. The owner is told that, in the app.
    -->
    <div class="mt-6 rounded-sm border border-fg/15 bg-surface-2 px-4 py-3 text-sm text-fg/80">
      To arrange payment, please contact {inv.companyName ?? 'the business'}{inv.companyEmail
        ? ` at ${inv.companyEmail}`
        : inv.companyPhone
          ? ` on ${inv.companyPhone}`
          : ''}.
    </div>
  {/if}

  <dl class="mt-8 grid grid-cols-1 gap-x-12 gap-y-6 sm:grid-cols-3">
    {#if inv.companyName && (inv.companyAddress || inv.companyPhone || inv.companyEmail)}
      <div>
        <dt class="label">From</dt>
        <dd class="mt-1 text-fg">{inv.companyName}</dd>
        {#if inv.companyAddress}
          <dd class="mt-1 whitespace-pre-line text-sm text-fg/70">{inv.companyAddress}</dd>
        {/if}
        {#if inv.companyPhone}
          <dd class="mt-1 text-sm text-fg/70">{inv.companyPhone}</dd>
        {/if}
        {#if inv.companyEmail}
          <dd class="mt-1 text-sm text-fg/70">{inv.companyEmail}</dd>
        {/if}
      </div>
    {/if}
    {#if inv.customerName}
      <div>
        <dt class="label">Bill to</dt>
        <dd class="mt-1 text-fg">{inv.customerName}</dd>
      </div>
    {/if}
    <div>
      <dt class="label">Issued</dt>
      <dd class="mt-1 text-fg">{inv.issueDate}</dd>
    </div>
    <div>
      <dt class="label">Due</dt>
      <dd class="mt-1 text-fg">{inv.dueDate}</dd>
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
        {#each inv.lineItems as li (li.id)}
          <tr>
            <td class="px-5 py-4 text-fg">
              {li.description}
              {#if li.taxable}
                <span class="block text-xs text-fg/40">Taxable · {Number(li.taxRatePct)}%</span>
              {/if}
            </td>
            <td class="px-5 py-4 text-right font-mono tabular-nums text-fg/80"
              >{li.quantity}{#if li.unitLabel}&nbsp;{li.unitLabel}{/if}</td
            >
            <td class="px-5 py-4 text-right font-mono tabular-nums text-fg/80">{formatUnitPrice(li.unitPrice)}</td>
            <td class="px-5 py-4 text-right font-mono tabular-nums text-fg">{li.amount}</td>
          </tr>
        {/each}
      </tbody>
      <tfoot class="bg-surface">
        <tr>
          <td
            colspan="3"
            class="px-5 py-3 text-right label"
          >
            Subtotal
          </td>
          <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">{inv.subtotal}</td>
        </tr>
        <tr>
          <td
            colspan="3"
            class="px-5 py-3 text-right label"
          >
            Tax
          </td>
          <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">{inv.tax}</td>
        </tr>
        <tr>
          <td
            colspan="3"
            class="px-5 py-3 text-right label"
          >
            Total ({inv.currency})
          </td>
          <td class="px-5 py-3 text-right font-mono tabular-nums text-lg text-fg">{inv.total}</td>
        </tr>
        {#if hasPaid}
          <tr>
            <td colspan="3" class="px-5 py-3 text-right label">Paid to date</td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-fg/70">−{inv.paid}</td>
          </tr>
          <tr>
            <td colspan="3" class="px-5 py-3 text-right label">
              {inv.settlement === 'overpaid' ? 'Overpaid by' : 'Balance due'}
            </td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-lg text-fg">
              {inv.settlement === 'overpaid' ? inv.outstanding.replace('-', '') : inv.outstanding}
            </td>
          </tr>
        {/if}
      </tfoot>
    </table>
  </div>

  {#if inv.notes}
    <div class="mt-8">
      <h2 class="label">Notes</h2>
      <p class="mt-2 whitespace-pre-wrap text-fg/80">{inv.notes}</p>
    </div>
  {/if}

  {#if inv.payable || offlineMethods.length > 0}
    <div class="mt-10 border-t border-fg/10 pt-8">
      <h2 class="label">Payment</h2>

      {#if inv.payable}
        <div class="mt-4">
          <a
            href="/pay/{page.params.token}"
            class="inline-block rounded-sm bg-inverse px-6 py-3 text-sm font-medium uppercase tracking-widest text-on-inverse transition-colors hover:bg-accent"
          >
            Pay {inv.outstanding} {inv.currency}
          </a>
          <p class="mt-2 font-mono text-xs uppercase tracking-widest text-fg/40">
            Secure card payment via Stripe
          </p>
        </div>
      {/if}

      {#if offlineMethods.length > 0}
        <div class="mt-6">
          {#if inv.payable}
            <p class="mb-3 text-sm text-fg/60">Or pay directly:</p>
          {/if}
          <dl class="grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {#each offlineMethods as m (m.label)}
              <div>
                <dt class="label">{m.label}</dt>
                <dd class="mt-1 whitespace-pre-line text-fg">{m.value}</dd>
              </div>
            {/each}
          </dl>
        </div>
      {/if}
    </div>
  {/if}

  <footer
    class="mt-12 border-t border-fg/10 pt-6 text-center font-mono text-xs uppercase tracking-widest text-fg/40"
  >
    Sent via Thalermark
  </footer>
</div>
