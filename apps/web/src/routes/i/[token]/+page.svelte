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
</script>

<div class="mx-auto max-w-3xl px-6 py-12 sm:py-20">
  <header class="flex flex-wrap items-start justify-between gap-6 border-b border-ink/10 pb-8">
    <div>
      <p class="eyebrow text-ink/50">{inv.companyName ?? 'Invoice'}</p>
      <h1 class="mt-2 font-serif text-4xl font-light leading-none tracking-tight text-ink">
        Invoice {inv.number}<span class="text-gold-deep">.</span>
      </h1>
    </div>
    <span
      class="rounded-sm border border-ink/15 px-3 py-1 font-mono text-xs uppercase tracking-widest text-ink/70"
    >
      {inv.status}
    </span>
  </header>

  {#if inv.status === 'paid'}
    <div
      class="mt-6 rounded-sm border border-emerald-700/30 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
    >
      Paid{#if inv.paidAt} on {inv.paidAt.slice(0, 10)}{/if}. Thank you.
    </div>
  {:else if inv.status === 'voided'}
    <div class="mt-6 rounded-sm border border-ink/20 bg-cream-warm px-4 py-3 text-sm text-ink/70">
      This invoice has been voided.
    </div>
  {:else if showProcessingBanner}
    <div
      class="mt-6 rounded-sm border border-gold-deep/30 bg-gold-deep/5 px-4 py-3 text-sm text-ink"
    >
      Payment received — finalizing. Refresh in a moment if this banner doesn't update.
    </div>
  {:else if inv.connectPending && inv.status === 'sent'}
    <div class="mt-6 rounded-sm border border-ink/15 bg-cream-warm px-4 py-3 text-sm text-ink/80">
      {inv.companyName ?? 'This business'} is finishing setting up online payments. Online pay will appear here once that's complete — usually a few minutes. You can still reach out to them directly in the meantime.
    </div>
  {/if}

  <dl class="mt-8 grid grid-cols-1 gap-x-12 gap-y-6 sm:grid-cols-3">
    {#if inv.customerName}
      <div>
        <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Bill to</dt>
        <dd class="mt-1 text-ink">{inv.customerName}</dd>
      </div>
    {/if}
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
          <td
            colspan="3"
            class="px-5 py-3 text-right font-mono text-xs uppercase tracking-widest text-ink/50"
          >
            Subtotal
          </td>
          <td class="px-5 py-3 text-right font-mono tabular-nums text-ink">{inv.subtotal}</td>
        </tr>
        <tr>
          <td
            colspan="3"
            class="px-5 py-3 text-right font-mono text-xs uppercase tracking-widest text-ink/50"
          >
            Tax
          </td>
          <td class="px-5 py-3 text-right font-mono tabular-nums text-ink">{inv.tax}</td>
        </tr>
        <tr>
          <td
            colspan="3"
            class="px-5 py-3 text-right font-mono text-xs uppercase tracking-widest text-ink/50"
          >
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

  {#if inv.payable}
    <div class="mt-10 border-t border-ink/10 pt-8">
      <a
        href="/pay/{page.params.token}"
        class="inline-block rounded-sm bg-ink px-6 py-3 text-sm font-medium uppercase tracking-widest text-cream transition-colors hover:bg-gold-deep"
      >
        Pay {inv.total} {inv.currency}
      </a>
      <p class="mt-3 font-mono text-xs uppercase tracking-widest text-ink/40">
        Secure payment via Stripe
      </p>
    </div>
  {/if}

  <footer
    class="mt-12 border-t border-ink/10 pt-6 text-center font-mono text-xs uppercase tracking-widest text-ink/40"
  >
    Sent via Thalermark
  </footer>
</div>
