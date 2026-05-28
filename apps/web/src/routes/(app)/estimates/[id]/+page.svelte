<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const est = $derived(data.estimate);
  const customer = $derived(data.customer);

  // Mirrors the API state machine. mark-sent only fires from draft;
  // mark-accepted / mark-declined fire from draft or sent (the operator
  // can capture a verbal close without going through send). Accepted +
  // declined are terminal, so their buttons disappear.
  const canMarkSent = $derived(est.status === 'draft');
  const canMarkAccepted = $derived(est.status === 'draft' || est.status === 'sent');
  const canMarkDeclined = $derived(est.status === 'draft' || est.status === 'sent');
  const canEdit = $derived(est.status === 'draft');
  // Convert is the "estimate → invoice" link action (slice 8.7d). Gated to
  // accepted estimates with no existing converted invoice; once converted,
  // the button is replaced with a link to the new invoice further down.
  const canConvert = $derived(est.status === 'accepted' && est.convertedInvoiceId == null);
  const hasActions = $derived(
    canMarkSent || canMarkAccepted || canMarkDeclined || canConvert,
  );

  // Advisory expiry: status doesn't flip to 'expired' in MVP (no background
  // sweep yet). Read sites compute the warning off expires_on < today, but
  // only on sent estimates — drafts haven't gone out, accepted/declined are
  // closed records, and an expires_on in the past on those carries no
  // operational signal.
  const todayIso = new Date().toISOString().slice(0, 10);
  const isExpired = $derived(
    est.status === 'sent' && est.expiresOn != null && est.expiresOn < todayIso,
  );

  // Share URL surfaces once mark-sent mints the token. Same pattern as the
  // invoice detail page — absolute URL built off origin so it works behind
  // any proxy. The unauthed /e/[token] public page lands in slice 8.7e;
  // until then the URL still works for any internal preview tooling.
  const publicUrl = $derived(est.publicToken ? `${data.origin}/e/${est.publicToken}` : null);
</script>

<a href="/estimates" class="eyebrow text-ink/60 hover:text-ink">← Estimates</a>
<div class="mt-3 flex items-baseline justify-between gap-6">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-ink">
    Estimate {est.number}<span class="text-gold-deep">.</span>
  </h1>
  <div class="flex items-center gap-3">
    {#if canEdit}
      <a
        href="/estimates/{est.id}/edit"
        class="rounded-sm border border-ink/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-ink/70 hover:border-gold-deep hover:text-gold-deep"
      >
        Edit
      </a>
    {/if}
    <span class="font-mono text-xs uppercase tracking-widest text-ink/60">{est.status}</span>
  </div>
</div>

{#if form?.transitionError}
  <div class="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3 text-sm text-oxblood">
    {form.transitionError}
  </div>
{/if}

{#if isExpired}
  <div class="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3 text-sm text-oxblood">
    This estimate's validity expired on <span class="font-medium">{est.expiresOn}</span>.
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
    {#if canMarkAccepted}
      <form method="post" action="?/markAccepted">
        <button
          type="submit"
          class="rounded-sm border border-ink/20 bg-cream-warm px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-gold-deep hover:text-gold-deep"
        >
          Mark accepted
        </button>
      </form>
    {/if}
    {#if canMarkDeclined}
      <form method="post" action="?/markDeclined">
        <button
          type="submit"
          class="rounded-sm border border-oxblood/30 px-4 py-2 text-sm font-medium text-oxblood transition-colors hover:bg-oxblood/5"
        >
          Mark declined
        </button>
      </form>
    {/if}
    {#if canConvert}
      <form method="post" action="?/convert">
        <button
          type="submit"
          class="rounded-sm bg-ink px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
        >
          Convert to invoice
        </button>
      </form>
    {/if}
  </div>
{/if}

{#if est.convertedInvoiceId}
  <div class="mt-6 rounded-sm border border-gold-deep/40 bg-gold-deep/5 px-4 py-3 text-sm text-ink">
    Converted to
    <a href="/invoices/{est.convertedInvoiceId}" class="font-medium text-gold-deep hover:underline">
      invoice →
    </a>
  </div>
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
      Anyone with this link can view the estimate.
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
        <td colspan="3" class="px-5 py-3 text-right font-mono text-xs uppercase tracking-widest text-ink/50">
          Subtotal
        </td>
        <td class="px-5 py-3 text-right font-mono tabular-nums text-ink">{est.subtotal}</td>
      </tr>
      <tr>
        <td colspan="3" class="px-5 py-3 text-right font-mono text-xs uppercase tracking-widest text-ink/50">
          Tax
        </td>
        <td class="px-5 py-3 text-right font-mono tabular-nums text-ink">{est.tax}</td>
      </tr>
      <tr>
        <td colspan="3" class="px-5 py-3 text-right font-mono text-xs uppercase tracking-widest text-ink/50">
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
