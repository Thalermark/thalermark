<script lang="ts">
  import { formatDateDisplay, formatMoneyDisplay, formatQuantity, formatUnitPrice } from '@thalermark/validation';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const est = $derived(data.estimate);

  const formError = $derived(form && 'formError' in form ? (form.formError as string) : null);
</script>

<div class="mx-auto max-w-3xl px-6 py-12 sm:py-20">
  <header class="flex flex-wrap items-start justify-between gap-6 border-b border-fg/10 pb-8">
    <div>
      {#if est.companyLogoUrl}
        <img
          src={est.companyLogoUrl}
          alt={est.companyName ?? 'Business logo'}
          class="mb-3 max-h-16 max-w-[12rem] object-contain"
        />
      {/if}
      <p class="eyebrow text-fg/50">{est.companyName ?? 'Estimate'}</p>
      <h1 class="mt-2 font-serif text-4xl font-light leading-none tracking-tight text-fg">
        Estimate {est.number}<span class="text-accent">.</span>
      </h1>
    </div>
    <span
      class="rounded-sm border border-fg/15 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70"
    >
      {est.beingRevised ? 'being revised' : est.status}
    </span>
  </header>

  {#if est.beingRevised}
    <!--
      Pulled back to be corrected (TMC-227). Accept and decline are already
      refused for anything but a sent estimate, so this says why the buttons are
      gone rather than leaving the recipient at a quote that stopped working.
    -->
    <div class="mt-6 rounded-sm border border-fg/20 bg-surface-2 px-4 py-3 text-sm text-fg/70">
      {est.companyName ?? 'The business'} is revising this estimate. The price may change. You'll
      get the corrected version shortly.
    </div>
  {:else if est.status === 'accepted'}
    <div
      class="mt-6 rounded-sm border border-success/30 bg-success/5 px-4 py-3 text-sm text-success"
    >
      Accepted{#if est.acceptedAt} on {est.acceptedAt.slice(0, 10)}{/if}. Thank you.
    </div>
  {:else if est.status === 'declined'}
    <div class="mt-6 rounded-sm border border-fg/20 bg-surface-2 px-4 py-3 text-sm text-fg/70">
      Declined{#if est.declinedAt} on {est.declinedAt.slice(0, 10)}{/if}.
    </div>
  {/if}

  {#if est.revisions.length > 0 && !est.beingRevised}
    <!-- What changed, said out loud — see the invoice page for the reasoning,
         including why this is hidden while a correction is still in flight. -->
    <div class="mt-6 space-y-1">
      {#each est.revisions as r (r.revisedAt)}
        <p class="text-sm text-fg/60">
          Revised {formatDateDisplay(r.revisedAt.slice(0, 10))}{r.previousTotal !== est.total
            ? ` (the total was ${formatMoneyDisplay(r.previousTotal, est.currency)})`
            : ''}.
        </p>
      {/each}
    </div>
  {/if}

  <dl class="mt-8 grid grid-cols-1 gap-x-12 gap-y-6 sm:grid-cols-3">
    {#if est.companyName && (est.companyAddress || est.companyPhone || est.companyEmail)}
      <div>
        <dt class="label">From</dt>
        <dd class="mt-1 text-fg">{est.companyName}</dd>
        {#if est.companyAddress}
          <dd class="mt-1 whitespace-pre-line text-sm text-fg/70">{est.companyAddress}</dd>
        {/if}
        {#if est.companyPhone}
          <dd class="mt-1 text-sm text-fg/70">{est.companyPhone}</dd>
        {/if}
        {#if est.companyEmail}
          <dd class="mt-1 text-sm text-fg/70">{est.companyEmail}</dd>
        {/if}
      </div>
    {/if}
    {#if est.customerName}
      <div>
        <dt class="label">For</dt>
        <dd class="mt-1 text-fg">{est.customerName}</dd>
      </div>
    {/if}
    <div>
      <dt class="label">Issued</dt>
      <dd class="mt-1 text-fg">{est.issueDate}</dd>
    </div>
    <div>
      <dt class="label">Expires</dt>
      <dd class="mt-1 text-fg">{est.expiresOn ?? '–'}</dd>
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
        {#each est.lineItems as li (li.id)}
          <tr>
            <td class="px-5 py-4 text-fg">
              {li.description}
              {#if li.taxable}
                <span class="block text-xs text-fg/40">Taxable · {Number(li.taxRatePct)}%</span>
              {/if}
            </td>
            <td class="px-5 py-4 text-right font-mono tabular-nums text-fg/80"
              >{formatQuantity(li.quantity)}{#if li.unitLabel}&nbsp;{li.unitLabel}{/if}</td
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
          <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">{est.subtotal}</td>
        </tr>
        <tr>
          <td
            colspan="3"
            class="px-5 py-3 text-right label"
          >
            Tax
          </td>
          <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">{est.tax}</td>
        </tr>
        <tr>
          <td
            colspan="3"
            class="px-5 py-3 text-right label"
          >
            Total ({est.currency})
          </td>
          <td class="px-5 py-3 text-right font-mono tabular-nums text-lg text-fg">{est.total}</td>
        </tr>
      </tfoot>
    </table>
  </div>

  {#if est.notes}
    <div class="mt-8">
      <h2 class="label">Notes</h2>
      <p class="mt-2 whitespace-pre-wrap text-fg/80">{est.notes}</p>
    </div>
  {/if}

  {#if est.canRespond}
    <div class="mt-10 flex flex-wrap items-center gap-3 border-t border-fg/10 pt-8">
      <form method="post" action="?/accept">
        <button
          type="submit"
          class="rounded-sm bg-inverse px-6 py-3 text-sm font-medium uppercase tracking-widest text-on-inverse transition-colors hover:bg-accent"
        >
          Accept
        </button>
      </form>
      <form method="post" action="?/decline">
        <button
          type="submit"
          class="rounded-sm border border-danger/30 px-6 py-3 text-sm font-medium uppercase tracking-widest text-danger transition-colors hover:bg-danger/5"
        >
          Decline
        </button>
      </form>
      {#if formError}
        <p class="basis-full text-sm text-danger">{formError}</p>
      {/if}
    </div>
  {/if}

  <footer
    class="mt-12 border-t border-fg/10 pt-6 text-center font-mono text-xs uppercase tracking-widest text-fg/40"
  >
    Sent via Thalermark
  </footer>
</div>
