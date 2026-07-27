<script lang="ts">
  import { enhance } from '$app/forms';
  import { BUSINESS_TYPES, BUSINESS_TYPE_LABELS, type BusinessType } from '@thalermark/validation';
  import { untrack } from 'svelte';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  const money = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  // Seeded once, then owned by the form — nothing is written until the final
  // submit, so this whole page is a draft.
  let name = $state(untrack(() => `${data.company.name} LLC`));
  let businessType = $state(untrack(() => data.suggestedType));
  let effectiveDate = $state(untrack(() => data.effectiveDate));
  let openInvoicesDisposition = $state('stay');
  let transferAssetIds = $state<string[]>(
    untrack(() => data.preview.assets.map((a) => a.id)),
  );
  let confirming = $state(false);
  let submitting = $state(false);

  const openInvoicesTotal = $derived(
    (Number(data.preview.openInvoicesTotal) / 100).toFixed(2),
  );

  function toggleAsset(id: string) {
    transferAssetIds = transferAssetIds.includes(id)
      ? transferAssetIds.filter((a) => a !== id)
      : [...transferAssetIds, id];
  }

  // What the old business is handing over, in the reader's terms rather than
  // debits and credits: a positive raw balance on an asset is something it owns.
  const owns = $derived(
    data.preview.balances.filter((b) => b.accountType === 'asset' && Number(b.amount) !== 0),
  );
  const owes = $derived(
    data.preview.balances.filter((b) => b.accountType === 'liability' && Number(b.amount) !== 0),
  );
</script>

<a href="/settings/business" class="eyebrow text-fg/60 hover:text-fg">← Business settings</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
  Set up the new business<span class="text-accent">.</span>
</h1>
<p class="mt-4 max-w-2xl text-sm leading-relaxed text-fg/60">
  Because you registered a new business with its own tax ID, it needs its own set of books —
  it files its own return, separately from <strong class="text-fg/80">{data.company.name}</strong>.
  We'll set it up, bring across your customers and prices, and move what
  {data.company.name} owns and owes onto the new books.
</p>
<p class="mt-3 max-w-2xl text-sm leading-relaxed text-fg/60">
  <strong class="text-fg/80">{data.company.name} stays exactly as it is</strong> — every invoice,
  expense and report is still there, so you can still file its final return. It just stops taking
  new work.
</p>

{#if form?.formError}
  <div class="mt-6 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    {form.formError}
  </div>
{/if}

<form method="POST" action="?/handoff" class="mt-8" use:enhance={() => {
  submitting = true;
  return async ({ update }) => {
    await update();
    submitting = false;
  };
}}>
  <input type="hidden" name="openInvoicesDisposition" value={openInvoicesDisposition} />
  {#each transferAssetIds as id (id)}
    <input type="hidden" name="transferAssetIds" value={id} />
  {/each}

  <!-- 1. The new business -->
  <section class="rounded-sm border border-fg/15 bg-surface-2">
    <header class="border-b border-fg/10 px-6 py-5">
      <span class="eyebrow">The new business</span>
    </header>
    <div class="space-y-5 px-6 py-6">
      <div>
        <label for="name" class="label">What's it called?<span class="text-accent">*</span></label>
        <input id="name" name="name" type="text" required bind:value={name} class="field mt-1" />
      </div>
      <div>
        <span class="label">How is it set up?</span>
        <div class="mt-2 space-y-2">
          {#each BUSINESS_TYPES as bt (bt)}
            <label class="flex cursor-pointer items-center gap-3 text-sm text-fg">
              <input type="radio" name="businessType" value={bt} bind:group={businessType} />
              <span>{BUSINESS_TYPE_LABELS[bt as BusinessType]}</span>
            </label>
          {/each}
        </div>
      </div>
      <div>
        <label for="effectiveDate" class="label">
          When did it take over?<span class="text-accent">*</span>
        </label>
        <p class="text-xs text-fg/50">
          The first day the new business was trading. Everything before this belongs to
          {data.company.name}.
        </p>
        <input
          id="effectiveDate"
          name="effectiveDate"
          type="date"
          required
          bind:value={effectiveDate}
          class="field mt-1"
        />
      </div>
    </div>
  </section>

  <!-- 2. What comes across -->
  <section class="mt-6 rounded-sm border border-fg/15 bg-surface-2">
    <header class="border-b border-fg/10 px-6 py-5">
      <span class="eyebrow">What comes across</span>
      <p class="mt-2 text-sm text-fg/70">
        Your customers, prices and settings carry over. Your invoices, expenses and reports stay
        with {data.company.name} — they're its records, and it still has to file them.
      </p>
    </header>
    <div class="space-y-3 px-6 py-6">
      {#each [['contacts', 'Customers and suppliers'], ['items', 'Your price list'], ['taxPolicies', 'Tax rates'], ['recurringInvoices', 'Repeating invoices (they arrive paused)'], ['emailTemplates', 'Your email wording'], ['profile', 'Address, phone and invoice settings'], ['branding', 'Your logo']] as [key, label] (key)}
        <label class="flex cursor-pointer items-center gap-3 text-sm text-fg">
          <input type="checkbox" name="include.{key}" checked />
          <span>{label}</span>
        </label>
      {/each}
    </div>
  </section>

  <!-- 3. Unpaid invoices — only when there are any -->
  {#if data.preview.openInvoices.length > 0}
    <section class="mt-6 rounded-sm border border-fg/15 bg-surface-2">
      <header class="border-b border-fg/10 px-6 py-5">
        <span class="eyebrow">Money customers still owe you</span>
        <p class="mt-2 text-sm text-fg/70">
          {data.company.name} has {data.preview.openInvoices.length}
          {data.preview.openInvoices.length === 1 ? 'invoice' : 'invoices'} sent but not paid, worth
          <span class="font-mono tabular-nums text-fg">{money(openInvoicesTotal)}</span>. Who
          collects them?
        </p>
      </header>
      <div class="space-y-3 px-6 py-6">
        <label class="flex cursor-pointer items-start gap-3 text-sm text-fg">
          <input type="radio" value="stay" bind:group={openInvoicesDisposition} class="mt-1" />
          <span>
            <strong class="font-medium">{data.company.name} collects them.</strong>
            <span class="block text-fg/60">
              It did the work and sent the bill, so the money belongs to it. You'll still be able to
              mark them paid.
            </span>
          </span>
        </label>
        <label class="flex cursor-pointer items-start gap-3 text-sm text-fg">
          <input type="radio" value="transfer" bind:group={openInvoicesDisposition} class="mt-1" />
          <span>
            <strong class="font-medium">The new business collects them.</strong>
            <span class="block text-fg/60">
              They come across as money owed to the new business. Worth checking with whoever does
              your taxes.
            </span>
          </span>
        </label>
      </div>
    </section>
  {/if}

  <!-- 4. Things you own — only when there are any -->
  {#if data.preview.assets.length > 0}
    <section class="mt-6 rounded-sm border border-fg/15 bg-surface-2">
      <header class="border-b border-fg/10 px-6 py-5">
        <span class="eyebrow">Things you own</span>
        <p class="mt-2 text-sm text-fg/70">
          Equipment carries over at what it originally cost, keeping whatever you've already
          written off — the new business picks up where this one left off rather than starting the
          clock again.
        </p>
      </header>
      <div class="divide-y divide-fg/10">
        {#each data.preview.assets as asset (asset.id)}
          <label class="flex cursor-pointer items-center gap-3 px-6 py-4 text-sm">
            <input
              type="checkbox"
              checked={transferAssetIds.includes(asset.id)}
              onchange={() => toggleAsset(asset.id)}
            />
            <span class="flex-1">
              <span class="text-fg">{asset.description}</span>
              <span class="block text-xs text-fg/50">
                Cost {money(asset.cost)} · written off so far {money(asset.accumulated)}
                {#if Number(asset.outstandingLoan) > 0}
                  · still owing {money(asset.outstandingLoan)}
                {/if}
              </span>
            </span>
          </label>
        {/each}
      </div>
    </section>
  {/if}

  <!-- 5. What moves -->
  <section class="mt-6 rounded-sm border border-fg/15 bg-surface-2">
    <header class="border-b border-fg/10 px-6 py-5">
      <span class="eyebrow">What moves onto the new books</span>
    </header>
    <div class="px-6 py-6">
      {#if owns.length === 0 && owes.length === 0}
        <p class="text-sm text-fg/60">Nothing yet — {data.company.name} has no balances to move.</p>
      {:else}
        <div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div>
            <p class="label">What it owns</p>
            <ul class="mt-2 space-y-1 text-sm">
              {#each owns as b (b.code)}
                <li class="flex justify-between gap-4">
                  <span class="text-fg/70">{b.name}</span>
                  <span class="font-mono tabular-nums text-fg">{money(b.amount)}</span>
                </li>
              {/each}
            </ul>
          </div>
          <div>
            <p class="label">What it owes</p>
            {#if owes.length === 0}
              <p class="mt-2 text-sm text-fg/50">Nothing.</p>
            {:else}
              <ul class="mt-2 space-y-1 text-sm">
                {#each owes as b (b.code)}
                  <li class="flex justify-between gap-4">
                    <span class="text-fg/70">{b.name}</span>
                    <span class="font-mono tabular-nums text-fg">{money(b.amount)}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </section>

  <!-- 6. Confirm -->
  <div class="mt-8">
    {#if confirming}
      <div class="rounded-sm border border-accent/30 bg-accent/5 px-5 py-4">
        <p class="max-w-prose text-sm leading-relaxed text-fg/80">
          Set up <strong class="font-medium text-fg">{name}</strong> and hand
          {data.company.name}'s books over to it, starting {effectiveDate}?
          {data.company.name} keeps all its records and stops taking new work.
        </p>
        <div class="mt-4 flex items-center gap-4">
          <button type="submit" class="btn" disabled={submitting}>
            {submitting ? 'Setting it up…' : 'Yes, set it up'}
          </button>
          <button
            type="button"
            class="text-sm text-fg/60 hover:text-fg"
            onclick={() => (confirming = false)}
          >
            Go back
          </button>
        </div>
      </div>
    {:else}
      <div class="flex items-center gap-4">
        <button type="button" class="btn" onclick={() => (confirming = true)}>Continue</button>
        <a href="/settings/business" class="text-sm text-fg/60 hover:text-fg">Cancel</a>
      </div>
    {/if}
  </div>
</form>
