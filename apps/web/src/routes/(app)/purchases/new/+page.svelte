<script lang="ts">
  import { enhance } from '$app/forms';
  import VendorPicker from '$lib/components/VendorPicker.svelte';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const fieldErrors = $derived(form?.fieldErrors ?? {});

  function err(key: string): string | undefined {
    return (fieldErrors as Record<string, string>)[key];
  }
  function v(key: string): string {
    const submitted = (form?.values as Record<string, unknown> | undefined)?.[key];
    return typeof submitted === 'string' ? submitted : '';
  }

  // The two plain forks. funding drives whether the down-payment field shows;
  // default "paid in full" and "deduct it all this year".
  let funding = $state(v('funding') || 'paid_in_full');
  let taxTreatment = $state(v('taxTreatment') || 'deduct_now');
  const dateValue = $derived(v('purchaseDate') || data.today);
</script>

<a href="/expenses/new" class="eyebrow text-fg/60 hover:text-fg">← New expense</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
  Log a big purchase<span class="text-accent">.</span>
</h1>
<p class="mt-4 max-w-2xl text-sm text-fg/60">
  Something you'll use for years — a mower, trailer, truck. We'll keep track of what you still owe
  and how it helps at tax time.
</p>

{#if form?.formError}
  <div class="mt-6 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    {form.formError}
  </div>
{/if}

<form method="post" action="?/save" class="mt-8 space-y-6" use:enhance>
  <div>
    <label for="description" class="label">What did you buy?<span class="text-accent">*</span></label>
    <input
      id="description"
      name="description"
      type="text"
      required
      maxlength="200"
      placeholder="e.g. Zero-turn mower"
      value={v('description')}
      class="field mt-1"
    />
    {#if err('description')}
      <p class="mt-1 text-xs text-danger">{err('description')}</p>
    {/if}
  </div>

  <div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
    <div>
      <label for="amount" class="label">How much was it?<span class="text-accent">*</span></label>
      <input
        id="amount"
        name="amount"
        type="text"
        inputmode="decimal"
        required
        placeholder="0.00"
        value={v('amount')}
        class="mt-1 w-full rounded-sm border border-fg/15 bg-surface-2 px-3 py-2 font-mono tabular-nums text-fg focus:border-accent focus:outline-none"
      />
      {#if err('amount')}
        <p class="mt-1 text-xs text-danger">{err('amount')}</p>
      {/if}
    </div>
    <div>
      <label for="purchaseDate" class="label">When?<span class="text-accent">*</span></label>
      <input id="purchaseDate" name="purchaseDate" type="date" required value={dateValue} class="field mt-1" />
    </div>
  </div>

  <fieldset>
    <span class="label">Did you pay all at once, or over time?<span class="text-accent">*</span></span>
    <div class="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label class="flex cursor-pointer items-center gap-2 rounded-sm border border-fg/15 bg-surface-2 px-4 py-3 hover:border-accent has-[:checked]:border-accent has-[:checked]:bg-accent/5">
        <input type="radio" name="funding" value="paid_in_full" bind:group={funding} class="text-accent focus:ring-accent" />
        <span class="font-serif text-fg">Paid it all at once</span>
      </label>
      <label class="flex cursor-pointer items-center gap-2 rounded-sm border border-fg/15 bg-surface-2 px-4 py-3 hover:border-accent has-[:checked]:border-accent has-[:checked]:bg-accent/5">
        <input type="radio" name="funding" value="financed" bind:group={funding} class="text-accent focus:ring-accent" />
        <span class="font-serif text-fg">Paying it off over time</span>
      </label>
    </div>
  </fieldset>

  {#if funding === 'financed'}
    <div>
      <label for="downPayment" class="label">How much did you put down? (if any)</label>
      <input
        id="downPayment"
        name="downPayment"
        type="text"
        inputmode="decimal"
        placeholder="0.00"
        value={v('downPayment')}
        class="mt-1 w-full rounded-sm border border-fg/15 bg-surface-2 px-3 py-2 font-mono tabular-nums text-fg focus:border-accent focus:outline-none"
      />
      {#if err('downPayment')}
        <p class="mt-1 text-xs text-danger">{err('downPayment')}</p>
      {/if}
    </div>
  {/if}

  <div>
    <span class="label">Who did you buy it from? <span class="font-normal normal-case tracking-normal text-fg/40">(optional)</span></span>
    <div class="mt-1">
      <VendorPicker initialMerchant="" initialVendorContactId={v('vendorContactId')} />
    </div>
  </div>

  <fieldset>
    <span class="label">How do you want to handle it on taxes?<span class="text-accent">*</span></span>
    <div class="mt-2 space-y-3">
      <label class="flex cursor-pointer flex-col gap-1 rounded-sm border border-fg/15 bg-surface-2 px-4 py-3 hover:border-accent has-[:checked]:border-accent has-[:checked]:bg-accent/5">
        <span class="flex items-center gap-2">
          <input type="radio" name="taxTreatment" value="deduct_now" bind:group={taxTreatment} class="text-accent focus:ring-accent" />
          <span class="font-serif text-fg">Deduct it all this year</span>
        </span>
        <span class="pl-6 text-xs text-fg/55">Write off the whole cost on this year's taxes.</span>
      </label>
      <label class="flex cursor-pointer flex-col gap-1 rounded-sm border border-fg/15 bg-surface-2 px-4 py-3 hover:border-accent has-[:checked]:border-accent has-[:checked]:bg-accent/5">
        <span class="flex items-center gap-2">
          <input type="radio" name="taxTreatment" value="spread" bind:group={taxTreatment} class="text-accent focus:ring-accent" />
          <span class="font-serif text-fg">Spread it out over the years you'll use it</span>
        </span>
        <span class="pl-6 text-xs text-fg/55">A little of the cost each year instead of all at once.</span>
      </label>
    </div>
  </fieldset>

  <div class="flex items-center gap-4">
    <button type="submit" class="btn">Save</button>
    <a href="/expenses/new" class="text-sm text-fg/60 hover:text-fg">Cancel</a>
  </div>
</form>
