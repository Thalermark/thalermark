<script lang="ts">
  import { page } from '$app/state';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const s = $derived(data.statement);

  const sentTo = $derived(page.url.searchParams.get('sent'));
  const emailError = $derived(form?.emailError ?? null);

  const fmt = (v: string) =>
    Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const custAddress = $derived(
    [
      s.customer.addressLine1,
      s.customer.addressLine2,
      [s.customer.city, s.customer.region, s.customer.postalCode].filter(Boolean).join(', ') || null,
      s.customer.country,
    ].filter((line): line is string => Boolean(line)),
  );
</script>

<!-- Toolbar — hidden when printing. -->
<div class="flex flex-wrap items-center justify-between gap-3 print:hidden">
  <a href="/customers/{s.customer.id}" class="eyebrow text-ink/60 hover:text-ink">← {s.customer.name}</a>
  <div class="flex flex-wrap items-center gap-2">
    <form method="POST" action="?/email" class="flex items-center gap-2">
      <input
        name="to"
        type="email"
        value={s.customer.email ?? ''}
        placeholder="customer@email.com"
        class="w-48 rounded-sm border border-ink/15 bg-cream-warm px-2 py-1.5 text-sm text-ink"
      />
      <button
        type="submit"
        class="rounded-sm border border-ink/20 px-3 py-1.5 text-sm font-medium text-ink/80 transition-colors hover:border-gold-deep hover:text-gold-deep"
      >
        Email statement
      </button>
    </form>
    <button
      onclick={() => window.print()}
      class="rounded-sm bg-ink px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
    >
      Print / save PDF
    </button>
  </div>
</div>

{#if sentTo}
  <p class="mt-3 rounded-sm border border-gold-deep/30 bg-gold-deep/5 px-4 py-2 text-sm text-ink/80 print:hidden">
    Statement emailed to {sentTo}.
  </p>
{:else if emailError}
  <p class="mt-3 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-2 text-sm text-oxblood print:hidden">
    {emailError === 'invalid_recipient'
      ? 'No valid email — add the customer’s email or type one above.'
      : emailError === 'email_not_configured'
        ? 'Email isn’t configured on this server.'
        : 'Could not send the statement. Please try again.'}
  </p>
{/if}

<!-- The document. -->
<article class="mt-6 rounded-sm border border-ink/10 bg-cream-warm p-8 print:border-0 print:bg-white print:p-0">
  <header class="flex items-start justify-between gap-8 border-b border-ink/10 pb-6">
    <div>
      <div class="font-serif text-2xl text-ink">{s.company.name}</div>
      {#if s.company.businessAddress}
        <div class="mt-1 whitespace-pre-line text-sm text-ink/70">{s.company.businessAddress}</div>
      {/if}
      {#if s.company.businessPhone}
        <div class="text-sm text-ink/70">{s.company.businessPhone}</div>
      {/if}
    </div>
    <div class="text-right">
      <div class="font-mono text-xs uppercase tracking-widest text-ink/50">Statement</div>
      <div class="mt-1 font-mono text-sm tabular-nums text-ink/70">{s.statementDate}</div>
    </div>
  </header>

  <div class="mt-6">
    <div class="font-mono text-xs uppercase tracking-widest text-ink/50">To</div>
    <div class="mt-1 font-serif text-lg text-ink">{s.customer.name}</div>
    {#if s.customer.email}<div class="text-sm text-ink/70">{s.customer.email}</div>{/if}
    {#each custAddress as line, i (i)}
      <div class="text-sm text-ink/70">{line}</div>
    {/each}
  </div>

  {#if s.lines.length === 0}
    <p class="mt-8 text-ink/70">No invoices on file for this customer.</p>
  {:else}
    <table class="mt-8 w-full text-left text-sm">
      <thead>
        <tr class="border-b border-ink/15 font-mono text-xs uppercase tracking-widest text-ink/50">
          <th class="py-2">Date</th>
          <th class="py-2">Description</th>
          <th class="py-2 text-right">Charge</th>
          <th class="py-2 text-right">Payment</th>
          <th class="py-2 text-right">Balance</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-ink/10">
        {#each s.lines as line, i (i)}
          <tr>
            <td class="py-2 font-mono tabular-nums text-ink/70">{line.date}</td>
            <td class="py-2 text-ink/80">{line.description}</td>
            <td class="py-2 text-right font-mono tabular-nums text-ink">
              {line.charge ? fmt(line.charge) : ''}
            </td>
            <td class="py-2 text-right font-mono tabular-nums text-ink/70">
              {line.payment ? fmt(line.payment) : ''}
            </td>
            <td class="py-2 text-right font-mono tabular-nums text-ink">{fmt(line.balance)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  <div class="mt-8 flex justify-end border-t-2 border-ink/15 pt-4">
    <div class="w-64">
      <div class="flex justify-between text-sm text-ink/70">
        <span>Total invoiced</span><span class="font-mono tabular-nums">{fmt(s.totalCharges)}</span>
      </div>
      <div class="mt-1 flex justify-between text-sm text-ink/70">
        <span>Total paid</span><span class="font-mono tabular-nums">{fmt(s.totalPayments)}</span>
      </div>
      <div class="mt-2 flex justify-between border-t border-ink/15 pt-2 font-mono text-sm uppercase tracking-widest text-ink">
        <span>Balance due</span>
        <span class="text-base tabular-nums">{fmt(s.balanceDue)}</span>
      </div>
    </div>
  </div>
</article>
