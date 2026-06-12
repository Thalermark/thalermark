<script lang="ts">
  import { enhance } from '$app/forms';
  import { untrack } from 'svelte';
  import { BUSINESS_TYPES } from '@thalermark/validation';
  import type { PageProps } from './$types';

  let { form }: PageProps = $props();

  // Same friendly labels as the welcome wizard — structure, not jargon.
  const BUSINESS_TYPE_LABELS: Record<(typeof BUSINESS_TYPES)[number], string> = {
    sole_prop: 'Just me (sole proprietor)',
    llc_single_member: 'LLC (single-member)',
    partnership: 'Partnership',
    s_corp: 'S-Corporation',
    c_corp: 'C-Corporation',
  };

  const formValue = (key: string) => (form?.values as Record<string, string> | undefined)?.[key];
  let name = $state(untrack(() => formValue('name') ?? ''));
  let businessType = $state(untrack(() => formValue('businessType') || 'sole_prop'));
  let submitting = $state(false);

  const fieldErrors = $derived((form?.fieldErrors as Record<string, string> | undefined) ?? {});
  const formError = $derived(form?.formError as string | undefined);
</script>

<div class="mx-auto max-w-xl">
  <span class="eyebrow">New company</span>
  <h1 class="mt-3 font-serif text-3xl font-light leading-tight tracking-tight text-ink">
    Add a company<span class="text-gold-deep">.</span>
  </h1>
  <p class="mt-4 text-ink/70">
    Run a second business out of this workspace — its books, invoices, and customers stay separate.
    You can switch between companies anytime from the menu.
  </p>

  <form
    method="POST"
    use:enhance={() => {
      submitting = true;
      return ({ update }) => {
        update().finally(() => {
          submitting = false;
        });
      };
    }}
    class="mt-8 space-y-8"
  >
    <label class="block">
      <span class="font-mono text-xs uppercase tracking-widest text-ink/60">Business name</span>
      <input
        type="text"
        name="name"
        bind:value={name}
        required
        placeholder="e.g. Northside Handyman"
        class="mt-2 w-full border-b border-ink/30 bg-transparent py-2 text-ink outline-none focus:border-ink"
      />
      {#if fieldErrors.name}
        <p class="mt-2 font-mono text-xs uppercase tracking-widest text-oxblood">
          {fieldErrors.name}
        </p>
      {/if}
    </label>

    <fieldset>
      <legend class="block font-mono text-xs uppercase tracking-widest text-ink/60">
        How's it set up?
      </legend>
      <div class="mt-4 space-y-3">
        {#each BUSINESS_TYPES as bt (bt)}
          <label class="flex cursor-pointer items-center gap-3 text-sm text-ink">
            <input
              type="radio"
              name="businessType"
              value={bt}
              bind:group={businessType}
              required
              class="h-4 w-4 border-ink/30 text-gold-deep focus:ring-gold-deep"
            />
            <span>{BUSINESS_TYPE_LABELS[bt]}</span>
          </label>
        {/each}
      </div>
      {#if fieldErrors.businessType}
        <p class="mt-2 font-mono text-xs uppercase tracking-widest text-oxblood">
          {fieldErrors.businessType}
        </p>
      {/if}
    </fieldset>

    {#if formError}
      <p class="font-mono text-xs uppercase tracking-widest text-oxblood">{formError}</p>
    {/if}

    <div class="flex items-center justify-between gap-4">
      <a href="/" class="font-mono text-xs uppercase tracking-widest text-ink/50 hover:text-ink">
        Cancel
      </a>
      <button
        type="submit"
        disabled={submitting}
        class="rounded-sm bg-ink px-6 py-3 text-sm font-medium text-cream transition-colors hover:bg-gold-deep disabled:opacity-50"
      >
        Create company
      </button>
    </div>
  </form>
</div>
