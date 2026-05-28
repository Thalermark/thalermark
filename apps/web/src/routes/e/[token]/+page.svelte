<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const est = $derived(data.estimate);

  const formError = $derived(form && 'formError' in form ? (form.formError as string) : null);
</script>

<div class="mx-auto max-w-3xl px-6 py-12 sm:py-20">
  <header class="flex flex-wrap items-start justify-between gap-6 border-b border-ink/10 pb-8">
    <div>
      <p class="eyebrow text-ink/50">{est.companyName ?? 'Estimate'}</p>
      <h1 class="mt-2 font-serif text-4xl font-light leading-none tracking-tight text-ink">
        Estimate {est.number}<span class="text-gold-deep">.</span>
      </h1>
    </div>
    <span
      class="rounded-sm border border-ink/15 px-3 py-1 font-mono text-xs uppercase tracking-widest text-ink/70"
    >
      {est.status}
    </span>
  </header>

  {#if est.status === 'accepted'}
    <div
      class="mt-6 rounded-sm border border-emerald-700/30 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
    >
      Accepted{#if est.acceptedAt} on {est.acceptedAt.slice(0, 10)}{/if}. Thank you.
    </div>
  {:else if est.status === 'declined'}
    <div class="mt-6 rounded-sm border border-ink/20 bg-cream-warm px-4 py-3 text-sm text-ink/70">
      Declined{#if est.declinedAt} on {est.declinedAt.slice(0, 10)}{/if}.
    </div>
  {/if}

  <dl class="mt-8 grid grid-cols-1 gap-x-12 gap-y-6 sm:grid-cols-3">
    {#if est.customerName}
      <div>
        <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">For</dt>
        <dd class="mt-1 text-ink">{est.customerName}</dd>
      </div>
    {/if}
    <div>
      <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Issued</dt>
      <dd class="mt-1 text-ink">{est.issueDate}</dd>
    </div>
    <div>
      <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Expires</dt>
      <dd class="mt-1 text-ink">{est.expiresOn ?? '—'}</dd>
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
        {#each est.lineItems as li (li.id)}
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
          <td class="px-5 py-3 text-right font-mono tabular-nums text-ink">{est.subtotal}</td>
        </tr>
        <tr>
          <td
            colspan="3"
            class="px-5 py-3 text-right font-mono text-xs uppercase tracking-widest text-ink/50"
          >
            Tax
          </td>
          <td class="px-5 py-3 text-right font-mono tabular-nums text-ink">{est.tax}</td>
        </tr>
        <tr>
          <td
            colspan="3"
            class="px-5 py-3 text-right font-mono text-xs uppercase tracking-widest text-ink/50"
          >
            Total ({est.currency})
          </td>
          <td class="px-5 py-3 text-right font-mono tabular-nums text-lg text-ink">{est.total}</td>
        </tr>
      </tfoot>
    </table>
  </div>

  {#if est.notes}
    <div class="mt-8">
      <h2 class="font-mono text-xs uppercase tracking-widest text-ink/50">Notes</h2>
      <p class="mt-2 whitespace-pre-wrap text-ink/80">{est.notes}</p>
    </div>
  {/if}

  {#if est.canRespond}
    <div class="mt-10 flex flex-wrap items-center gap-3 border-t border-ink/10 pt-8">
      <form method="post" action="?/accept">
        <button
          type="submit"
          class="rounded-sm bg-ink px-6 py-3 text-sm font-medium uppercase tracking-widest text-cream transition-colors hover:bg-gold-deep"
        >
          Accept
        </button>
      </form>
      <form method="post" action="?/decline">
        <button
          type="submit"
          class="rounded-sm border border-oxblood/30 px-6 py-3 text-sm font-medium uppercase tracking-widest text-oxblood transition-colors hover:bg-oxblood/5"
        >
          Decline
        </button>
      </form>
      {#if formError}
        <p class="basis-full text-sm text-oxblood">{formError}</p>
      {/if}
    </div>
  {/if}

  <footer
    class="mt-12 border-t border-ink/10 pt-6 text-center font-mono text-xs uppercase tracking-widest text-ink/40"
  >
    Sent via Thalermark
  </footer>
</div>
