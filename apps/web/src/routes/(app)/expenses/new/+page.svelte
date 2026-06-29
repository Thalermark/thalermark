<script lang="ts">
  import { enhance } from '$app/forms';
  import VendorPicker from '$lib/components/VendorPicker.svelte';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const values = $derived(form?.values ?? {});
  const fieldErrors = $derived(form?.fieldErrors ?? {});

  // True while a Suggest request is in flight, so the UI can show a spinner and
  // hide the previous result banner until the new response lands.
  let suggesting = $state(false);

  // enhance resets the form on a successful action by default. The Suggest
  // action succeeds even when no category fits, so a reset would wipe the
  // user's typed merchant/amount — keep values (apply the result, don't reset).
  // It also drives the `suggesting` flag for the Suggest button (detected via
  // the resolved action, which reflects the submitter's formaction).
  const onsubmit = ({ action }: { action: URL }) => {
    if (action.search.includes('suggest')) suggesting = true;
    return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
      await update({ reset: false });
      suggesting = false;
    };
  };

  type FieldKey = 'merchant' | 'vendorContactId' | 'amount' | 'expenseDate' | 'categoryAccountId' | 'paymentAccountId' | 'memo';

  // Priority: a submitted value (the user just typed it, via a fail()/suggest
  // re-render) > a ?duplicate prefill from load > empty. So duplicating seeds
  // the field but a re-submit always wins.
  function v(key: FieldKey): string {
    const submitted = (values as Record<string, unknown>)[key];
    if (typeof submitted === 'string') return submitted;
    const seeded = (data.prefill as Record<string, string> | undefined)?.[key];
    return typeof seeded === 'string' ? seeded : '';
  }
  function err(key: FieldKey): string | undefined {
    return (fieldErrors as Record<string, string>)[key];
  }

  // Date defaults to today on a fresh load; a fail()-re-render keeps whatever
  // the user typed.
  const dateValue = $derived(v('expenseDate') || data.today);
  const categoryValue = $derived(v('categoryAccountId'));
  const paymentValue = $derived(v('paymentAccountId') || data.defaultPaymentId);
</script>

<a href="/expenses" class="eyebrow text-fg/60 hover:text-fg">← Expenses</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
  New expense<span class="text-accent">.</span>
</h1>

<!-- The plain front door for capital purchases: durable gear gets handled
     differently underneath (kept as an asset, optionally financed, written off
     or spread over time), so route a "yes" into the big-purchase flow rather
     than booking it as a normal cost. -->
<a
  href="/purchases/new"
  class="mt-6 flex items-center justify-between gap-4 rounded-sm border border-fg/15 bg-surface-2 px-5 py-4 hover:border-accent"
>
  <div>
    <span class="font-serif text-fg">Will you use this for years?</span>
    <p class="mt-0.5 text-xs text-fg/55">
      Something big like a mower, trailer, or truck — log it as a big purchase instead.
    </p>
  </div>
  <span class="font-mono text-xs uppercase tracking-widest text-accent">Big purchase →</span>
</a>

{#if form?.formError}
  <div class="mt-6 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    {form.formError}
  </div>
{/if}

{#if suggesting}
  <div class="mt-6 flex items-center gap-2 rounded-sm border border-accent/30 bg-accent/5 px-4 py-3 text-sm text-fg/80">
    <span class="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent"></span>
    Finding the best category…
  </div>
{:else if form?.suggested}
  <div class="mt-6 rounded-sm border border-accent/30 bg-accent/5 px-4 py-3 text-sm text-fg/80">
    Suggested a category from what you typed — review it and save.
  </div>
{:else if form?.suggestNotice}
  <div class="mt-6 rounded-sm border border-fg/15 bg-surface-2 px-4 py-3 text-sm text-fg/70">
    {form.suggestNotice}
  </div>
{:else if form?.suggestError}
  <div class="mt-6 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    {form.suggestError}
  </div>
{/if}

<form method="post" action="?/save" class="mt-8 space-y-6" use:enhance={onsubmit}>
  <div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
    <div>
      <label for="merchant" class="label">
        Vendor<span class="text-accent">*</span>
      </label>
      <VendorPicker
        initialMerchant={v('merchant')}
        initialVendorContactId={v('vendorContactId')}
        required
      />
      {#if err('merchant')}
        <p class="mt-1 text-xs text-danger">{err('merchant')}</p>
      {/if}
    </div>
    <div>
      <label for="amount" class="label">
        Amount<span class="text-accent">*</span>
      </label>
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
  </div>

  <div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
    <div>
      <label for="expenseDate" class="label">
        Date<span class="text-accent">*</span>
      </label>
      <input
        id="expenseDate"
        name="expenseDate"
        type="date"
        required
        value={dateValue}
        class="field mt-1"
      />
      {#if err('expenseDate')}
        <p class="mt-1 text-xs text-danger">{err('expenseDate')}</p>
      {/if}
    </div>
    <div>
      <div class="flex items-baseline justify-between">
        <label for="categoryAccountId" class="label">
          Category<span class="text-accent">*</span>
        </label>
        <!-- formnovalidate: suggest with just a merchant typed, without tripping
             the other required fields. Submits to the ?/suggest action. -->
        <button
          type="submit"
          formaction="?/suggest"
          formnovalidate
          disabled={suggesting}
          class="flex items-center gap-1.5 font-mono text-xs uppercase tracking-widest text-accent hover:text-fg disabled:opacity-60"
        >
          {#if suggesting}
            <span class="inline-block h-3 w-3 animate-spin rounded-full border border-accent border-t-transparent"></span>
            Suggesting…
          {:else}
            ✨ Suggest
          {/if}
        </button>
      </div>
      <select
        id="categoryAccountId"
        name="categoryAccountId"
        required
        class="field mt-1"
      >
        <option value="" disabled selected={categoryValue === ''}>Select a category…</option>
        {#each data.categories as cat (cat.id)}
          <option value={cat.id} selected={categoryValue === cat.id}>{cat.label}</option>
        {/each}
      </select>
      {#if err('categoryAccountId')}
        <p class="mt-1 text-xs text-danger">{err('categoryAccountId')}</p>
      {/if}
    </div>
  </div>

  {#if data.paymentPickerVisible}
    <div class="sm:w-1/2 sm:pr-3">
      <label for="paymentAccountId" class="label">
        Paid from
      </label>
      <select
        id="paymentAccountId"
        name="paymentAccountId"
        class="field mt-1"
      >
        {#each data.paymentAccounts as acc (acc.id)}
          <option value={acc.id} selected={paymentValue === acc.id}>{acc.label}</option>
        {/each}
      </select>
      {#if err('paymentAccountId')}
        <p class="mt-1 text-xs text-danger">{err('paymentAccountId')}</p>
      {/if}
    </div>
  {:else}
    <input type="hidden" name="paymentAccountId" value={data.defaultPaymentId} />
  {/if}

  <div>
    <label for="memo" class="label">Memo</label>
    <textarea
      id="memo"
      name="memo"
      rows="3"
      maxlength="5000"
      class="field mt-1"
      >{v('memo')}</textarea
    >
  </div>

  <div class="flex items-center gap-4">
    <button
      type="submit"
      class="btn"
    >
      Save expense
    </button>
    <a href="/expenses" class="text-sm text-fg/60 hover:text-fg">Cancel</a>
  </div>
</form>
