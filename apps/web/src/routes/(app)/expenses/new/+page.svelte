<script lang="ts">
  import { enhance } from '$app/forms';
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

  type FieldKey = 'merchant' | 'amount' | 'expenseDate' | 'categoryAccountId' | 'paymentAccountId' | 'memo';

  function v(key: FieldKey): string {
    const raw = (values as Record<string, unknown>)[key];
    return typeof raw === 'string' ? raw : '';
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

<a href="/expenses" class="eyebrow text-ink/60 hover:text-ink">← Expenses</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-ink">
  New expense<span class="text-gold-deep">.</span>
</h1>

{#if form?.formError}
  <div class="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3 text-sm text-oxblood">
    {form.formError}
  </div>
{/if}

{#if suggesting}
  <div class="mt-6 flex items-center gap-2 rounded-sm border border-gold-deep/30 bg-gold-deep/5 px-4 py-3 text-sm text-ink/80">
    <span class="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-gold-deep border-t-transparent"></span>
    Finding the best category…
  </div>
{:else if form?.suggested}
  <div class="mt-6 rounded-sm border border-gold-deep/30 bg-gold-deep/5 px-4 py-3 text-sm text-ink/80">
    Suggested a category from what you typed — review it and save.
  </div>
{:else if form?.suggestNotice}
  <div class="mt-6 rounded-sm border border-ink/15 bg-cream-warm px-4 py-3 text-sm text-ink/70">
    {form.suggestNotice}
  </div>
{:else if form?.suggestError}
  <div class="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3 text-sm text-oxblood">
    {form.suggestError}
  </div>
{/if}

<form method="post" action="?/save" class="mt-8 space-y-6" use:enhance={onsubmit}>
  <div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
    <div>
      <label for="merchant" class="font-mono text-xs uppercase tracking-widest text-ink/50">
        Merchant<span class="text-gold-deep">*</span>
      </label>
      <input
        id="merchant"
        name="merchant"
        type="text"
        required
        maxlength="200"
        value={v('merchant')}
        class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
      />
      {#if err('merchant')}
        <p class="mt-1 text-xs text-oxblood">{err('merchant')}</p>
      {/if}
    </div>
    <div>
      <label for="amount" class="font-mono text-xs uppercase tracking-widest text-ink/50">
        Amount<span class="text-gold-deep">*</span>
      </label>
      <input
        id="amount"
        name="amount"
        type="text"
        inputmode="decimal"
        required
        placeholder="0.00"
        value={v('amount')}
        class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 font-mono tabular-nums text-ink focus:border-gold-deep focus:outline-none"
      />
      {#if err('amount')}
        <p class="mt-1 text-xs text-oxblood">{err('amount')}</p>
      {/if}
    </div>
  </div>

  <div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
    <div>
      <label for="expenseDate" class="font-mono text-xs uppercase tracking-widest text-ink/50">
        Date<span class="text-gold-deep">*</span>
      </label>
      <input
        id="expenseDate"
        name="expenseDate"
        type="date"
        required
        value={dateValue}
        class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
      />
      {#if err('expenseDate')}
        <p class="mt-1 text-xs text-oxblood">{err('expenseDate')}</p>
      {/if}
    </div>
    <div>
      <div class="flex items-baseline justify-between">
        <label for="categoryAccountId" class="font-mono text-xs uppercase tracking-widest text-ink/50">
          Category<span class="text-gold-deep">*</span>
        </label>
        <!-- formnovalidate: suggest with just a merchant typed, without tripping
             the other required fields. Submits to the ?/suggest action. -->
        <button
          type="submit"
          formaction="?/suggest"
          formnovalidate
          disabled={suggesting}
          class="flex items-center gap-1.5 font-mono text-xs uppercase tracking-widest text-gold-deep hover:text-ink disabled:opacity-60"
        >
          {#if suggesting}
            <span class="inline-block h-3 w-3 animate-spin rounded-full border border-gold-deep border-t-transparent"></span>
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
        class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
      >
        <option value="" disabled selected={categoryValue === ''}>Select a category…</option>
        {#each data.categories as cat (cat.id)}
          <option value={cat.id} selected={categoryValue === cat.id}>{cat.label}</option>
        {/each}
      </select>
      {#if err('categoryAccountId')}
        <p class="mt-1 text-xs text-oxblood">{err('categoryAccountId')}</p>
      {/if}
    </div>
  </div>

  {#if data.paymentPickerVisible}
    <div class="sm:w-1/2 sm:pr-3">
      <label for="paymentAccountId" class="font-mono text-xs uppercase tracking-widest text-ink/50">
        Paid from
      </label>
      <select
        id="paymentAccountId"
        name="paymentAccountId"
        class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
      >
        {#each data.paymentAccounts as acc (acc.id)}
          <option value={acc.id} selected={paymentValue === acc.id}>{acc.label}</option>
        {/each}
      </select>
      {#if err('paymentAccountId')}
        <p class="mt-1 text-xs text-oxblood">{err('paymentAccountId')}</p>
      {/if}
    </div>
  {:else}
    <input type="hidden" name="paymentAccountId" value={data.defaultPaymentId} />
  {/if}

  <div>
    <label for="memo" class="font-mono text-xs uppercase tracking-widest text-ink/50">Memo</label>
    <textarea
      id="memo"
      name="memo"
      rows="3"
      maxlength="5000"
      class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
      >{v('memo')}</textarea
    >
  </div>

  <div class="flex items-center gap-4">
    <button
      type="submit"
      class="rounded-sm bg-ink px-5 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
    >
      Save expense
    </button>
    <a href="/expenses" class="text-sm text-ink/60 hover:text-ink">Cancel</a>
  </div>
</form>
