<script lang="ts">
  import { enhance } from '$app/forms';
  import VendorPicker from '$lib/components/VendorPicker.svelte';
  import { trackFlowAbandonment } from '$lib/flow-abandonment';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const values = $derived(form?.values ?? {});
  const fieldErrors = $derived(form?.fieldErrors ?? {});

  // True while a Suggest request is in flight, so the UI can show a spinner and
  // hide the previous result banner until the new response lands.
  let suggesting = $state(false);

  // Photo-first (TMC-295 / TMC-235). Opening this page asks ONE question —
  // type it in, or start from a receipt — every time (a remembered choice is
  // state nobody can see, and a no-receipt expense must not be trapped behind
  // it). The chosen file lives in the always-mounted file input, so it
  // survives the ?/extract round-trip and rides the ?/save submit, where the
  // server creates the expense with the receipt attached in one call.
  // ?duplicate skips the chooser (that entry point already answered it).
  let manualChosen = $state(false);
  let extracting = $state(false);
  let attachedName = $state<string | null>(null);
  let fileInput: HTMLInputElement | null = $state(null);
  let extractBtn: HTMLButtonElement | null = $state(null);
  const showChooser = $derived(
    !form && !data.skipChooser && !manualChosen && !attachedName && !extracting,
  );

  function onFileChosen() {
    const chosen = fileInput?.files?.[0];
    if (!chosen) return;
    attachedName = chosen.name;
    // Reading starts immediately — the form comes back prefilled (or plainly
    // empty with the photo kept, when the read fails). requestSubmit with the
    // hidden button honours its formaction + formnovalidate.
    if (extractBtn) {
      extracting = true;
      extractBtn.form?.requestSubmit(extractBtn);
    }
  }

  function removeReceipt() {
    if (fileInput) fileInput.value = '';
    attachedName = null;
  }

  // enhance resets the form on a successful action by default. The Suggest
  // action succeeds even when no category fits, so a reset would wipe the
  // user's typed merchant/amount — keep values (apply the result, don't reset).
  // It also drives the `suggesting` flag for the Suggest button (detected via
  // the resolved action, which reflects the submitter's formaction), and the
  // `extracting` flag for the receipt read the same way.
  const onsubmit = ({ action }: { action: URL }) => {
    const isSuggest = action.search.includes('suggest');
    const isExtract = action.search.includes('extract');
    if (isSuggest) suggesting = true;
    if (isExtract) extracting = true;
    return async ({
      result,
      update,
    }: {
      result: { type: string };
      update: (o?: { reset?: boolean }) => Promise<void>;
    }) => {
      // A successful save redirects away — mark submitted so that redirect nav
      // isn't logged as abandonment. A failed save re-renders in place (no nav),
      // so leave the tracker armed. Suggest/extract are neither, and never mark it.
      if (!isSuggest && !isExtract && result.type === 'redirect') flow.markSubmitted();
      await update({ reset: false });
      suggesting = false;
      extracting = false;
    };
  };

  // expense_flow_abandoned: emit the furthest section reached if the user leaves
  // without saving. Reachable steps: 'amount' (vendor/amount/date) → 'category'.
  const flow = trackFlowAbandonment('expense_flow_abandoned', ['amount', 'category']);

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
  <div class="mt-6 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger" data-form-error role="alert" tabindex="-1">
    {form.formError}
  </div>
{/if}

{#if extracting}
  <div class="mt-6 flex items-center gap-2 rounded-sm border border-accent/30 bg-accent/5 px-4 py-3 text-sm text-fg/80">
    <span class="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent"></span>
    Reading your receipt…
  </div>
{:else if form?.extracted}
  <div class="mt-6 rounded-sm border border-accent/30 bg-accent/5 px-4 py-3 text-sm text-fg/80">
    {form.extracted === 'full'
      ? 'Read from your receipt — check the details and save.'
      : 'Read part of your receipt — fill in the rest and save. The photo saves with the expense.'}
  </div>
{:else if form?.receiptNotice}
  <div class="mt-6 rounded-sm border border-fg/15 bg-surface-2 px-4 py-3 text-sm text-fg/70">
    {form.receiptNotice}
  </div>
{:else if form?.receiptError}
  <div class="mt-6 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    {form.receiptError}
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

<!-- The one prompt (TMC-295): manual or receipt-first, asked on every fresh
     open. "Type it in" and nothing else stands between a bank fee and the
     form; the receipt path opens the file picker and reads the photo. -->
{#if showChooser}
  <div class="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
    <button
      type="button"
      onclick={() => fileInput?.click()}
      class="rounded-sm border border-fg/15 bg-surface-2 px-5 py-6 text-left hover:border-accent"
    >
      <span class="font-serif text-lg text-fg">Start with the receipt</span>
      <p class="mt-1 text-sm text-fg/60">
        Upload a photo or PDF — the details fill themselves in, you check and save.
      </p>
    </button>
    <button
      type="button"
      onclick={() => (manualChosen = true)}
      class="rounded-sm border border-fg/15 bg-surface-2 px-5 py-6 text-left hover:border-accent"
    >
      <span class="font-serif text-lg text-fg">Type it in</span>
      <p class="mt-1 text-sm text-fg/60">No receipt, or you'd rather enter it by hand.</p>
    </button>
  </div>
  {#if data.aiHint}
    <p class="mt-3 text-xs text-fg/55">
      Receipts aren't read automatically on this server — the photo still saves with the expense.
      Turn reading on in <a href="/settings/ai" class="text-accent hover:text-fg">Settings → AI</a>.
    </p>
  {/if}
{/if}

<form
  method="post"
  action="?/save"
  enctype="multipart/form-data"
  class="mt-8 space-y-6"
  class:hidden={showChooser}
  use:enhance={onsubmit}
>
  <!-- Always mounted so the chosen file survives the ?/extract re-render and
       rides the ?/save submit (the server then creates expense + receipt in
       one call). The hidden button carries ?/extract for requestSubmit. -->
  <input
    bind:this={fileInput}
    type="file"
    name="file"
    accept="image/jpeg,image/png,application/pdf"
    class="hidden"
    onchange={onFileChosen}
  />
  <button
    bind:this={extractBtn}
    type="submit"
    formaction="?/extract"
    formnovalidate
    class="hidden"
    aria-label="Read the receipt"
    tabindex="-1"
  ></button>

  {#if attachedName}
    <div class="flex items-center justify-between gap-3 rounded-sm border border-fg/15 bg-surface-2 px-4 py-3">
      <span class="truncate text-sm text-fg/80">📎 {attachedName} — saves with the expense</span>
      <button
        type="button"
        onclick={removeReceipt}
        class="font-mono text-xs uppercase tracking-widest text-danger hover:opacity-80"
      >
        Remove
      </button>
    </div>
  {:else}
    <button
      type="button"
      onclick={() => fileInput?.click()}
      class="font-mono text-xs uppercase tracking-widest text-accent hover:text-fg"
    >
      📎 Start with a receipt photo
    </button>
  {/if}

  <div class="grid grid-cols-1 gap-6 sm:grid-cols-2" onfocusin={() => flow.reach('amount')}>
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
    <div onfocusin={() => flow.reach('amount')}>
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
    <div onfocusin={() => flow.reach('category')}>
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
