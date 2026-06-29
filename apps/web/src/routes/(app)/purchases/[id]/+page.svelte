<script lang="ts">
  import { enhance } from '$app/forms';
  import AuditHistory from '$lib/components/AuditHistory.svelte';
  import { may } from '$lib/perms';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const p = $derived(data.purchase);
  const canWrite = $derived(may(data.role, 'expenses:write'));
  const money = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const financed = $derived(p.funding === 'financed');
  const stillOwes = $derived(Number(p.owing) > 0);
</script>

<a href="/purchases" class="eyebrow text-fg/60 hover:text-fg">← Big purchases</a>
<div class="mt-3 flex items-baseline justify-between gap-6">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
    {p.description}<span class="text-accent">.</span>
  </h1>
</div>

{#if form?.deleteError}
  <div class="mt-4 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    {form.deleteError}
  </div>
{/if}

<!-- The plain answer up top: what you still owe (if financed). -->
{#if financed}
  <div class="mt-6 rounded-sm border border-fg/10 bg-surface-2 px-5 py-4">
    {#if stillOwes}
      <span class="label">You still owe</span>
      <p class="mt-1 font-mono text-2xl tabular-nums text-fg">{money(p.owing)}</p>
    {:else}
      <p class="font-serif text-fg">Paid off — you don't owe anything more on this.</p>
    {/if}
  </div>
{/if}

<dl class="mt-8 grid grid-cols-1 gap-x-12 gap-y-6 sm:grid-cols-2">
  <div>
    <dt class="label">Cost</dt>
    <dd class="mt-1 font-mono tabular-nums text-fg">{money(p.amount)}</dd>
  </div>
  <div>
    <dt class="label">Bought</dt>
    <dd class="mt-1 font-mono tabular-nums text-fg">{p.purchaseDate}</dd>
  </div>
  {#if p.vendorName}
    <div>
      <dt class="label">From</dt>
      <dd class="mt-1 text-fg">{p.vendorName}</dd>
    </div>
  {/if}
  <div>
    <dt class="label">On taxes</dt>
    <dd class="mt-1 text-fg/80">
      {#if p.schedule}
        Spread out — about {money(p.schedule.perYear)} a year for {p.schedule.years} years.
      {:else}
        Deducted in full the year you bought it.
      {/if}
    </dd>
  </div>
</dl>

<!-- Record a payment toward a financed purchase while a balance remains. -->
{#if canWrite && financed && stillOwes}
  <div class="mt-10 rounded-sm border border-fg/10 bg-surface-2 p-5">
    <span class="label">Record a payment</span>
    {#if form?.paymentError}
      <p class="mt-2 text-xs text-danger">{form.paymentError}</p>
    {/if}
    <form method="post" action="?/recordPayment" class="mt-3 space-y-4" use:enhance>
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label for="amount" class="label">Amount paid<span class="text-accent">*</span></label>
          <input
            id="amount"
            name="amount"
            type="text"
            inputmode="decimal"
            required
            placeholder="0.00"
            class="mt-1 w-full rounded-sm border border-fg/15 bg-surface px-3 py-2 font-mono tabular-nums text-fg focus:border-accent focus:outline-none"
          />
        </div>
        <div>
          <label for="interest" class="label">
            Of that, interest <span class="font-normal normal-case tracking-normal text-fg/40">(optional)</span>
          </label>
          <input
            id="interest"
            name="interest"
            type="text"
            inputmode="decimal"
            placeholder="0.00"
            class="mt-1 w-full rounded-sm border border-fg/15 bg-surface px-3 py-2 font-mono tabular-nums text-fg focus:border-accent focus:outline-none"
          />
        </div>
        <div>
          <label for="paidOn" class="label">Date<span class="text-accent">*</span></label>
          <input id="paidOn" name="paidOn" type="date" required value={data.today} class="field mt-1" />
        </div>
      </div>
      <button type="submit" class="btn">Record payment</button>
    </form>
  </div>
{/if}

{#if canWrite}
  <form method="post" action="?/delete" class="mt-8 border-t border-fg/10 pt-6" use:enhance>
    <p class="text-sm text-fg/60">Logged this by mistake? Remove it from your books.</p>
    <button
      type="submit"
      class="mt-3 rounded-sm border border-danger/30 px-3 py-1 font-mono text-xs uppercase tracking-widest text-danger/80 hover:border-danger hover:text-danger"
    >
      Remove this purchase
    </button>
  </form>
{/if}

<AuditHistory events={data.auditEvents} />
