<script lang="ts">
  import { page } from '$app/state';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const inv = $derived(data.invoice);

  // Stripe redirects back here as ?paid=1 after a successful payment on the
  // /pay route. The webhook usually beats the redirect, so the page typically
  // already shows status=paid; this query flag is the fallback for the race
  // where the recipient lands before the webhook commits.
  const showProcessingBanner = $derived(
    page.url.searchParams.get('paid') === '1' && inv.status === 'sent',
  );

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
  {:else if showProcessingBanner}
    <div
      class="mt-6 rounded-sm border border-accent/30 bg-accent/5 px-4 py-3 text-sm text-fg"
    >
      Payment received — finalizing. Refresh in a moment if this banner doesn't update.
    </div>
  {:else if inv.connectPending && inv.status === 'sent'}
    <div class="mt-6 rounded-sm border border-fg/15 bg-surface-2 px-4 py-3 text-sm text-fg/80">
      {inv.companyName ?? 'This business'} is finishing setting up online payments. Online pay will appear here once that's complete — usually a few minutes. You can still reach out to them directly in the meantime.
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
            <td class="px-5 py-4 text-fg">{li.description}</td>
            <td class="px-5 py-4 text-right font-mono tabular-nums text-fg/80">{li.quantity}</td>
            <td class="px-5 py-4 text-right font-mono tabular-nums text-fg/80">{li.unitPrice}</td>
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
            Pay {inv.total} {inv.currency}
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
