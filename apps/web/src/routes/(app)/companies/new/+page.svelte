<script lang="ts">
  import { enhance } from '$app/forms';
  import { untrack } from 'svelte';
  import { BUSINESS_TYPES, BUSINESS_TYPE_LABELS } from '@thalermark/validation';
  import type { PageProps } from './$types';

  let { form }: PageProps = $props();

  const formValue = (key: string) => (form?.values as Record<string, string> | undefined)?.[key];
  let name = $state(untrack(() => formValue('name') ?? ''));
  let businessType = $state(untrack(() => formValue('businessType') || 'sole_prop'));
  let submitting = $state(false);

  const fieldErrors = $derived((form?.fieldErrors as Record<string, string> | undefined) ?? {});
  const formError = $derived(form?.formError as string | undefined);
</script>

<div class="mx-auto max-w-xl">
  <span class="eyebrow">New company</span>
  <h1 class="mt-3 font-serif text-3xl font-light leading-tight tracking-tight text-fg">
    Add a company<span class="text-accent">.</span>
  </h1>
  <p class="mt-4 text-fg/70">
    Run a second business out of this workspace — its books, invoices, and contacts stay separate.
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
      <span class="font-mono text-xs uppercase tracking-widest text-fg/60">Business name</span>
      <input
        type="text"
        name="name"
        bind:value={name}
        required
        placeholder="e.g. Northside Handyman"
        class="mt-2 w-full border-b border-fg/30 bg-transparent py-2 text-fg outline-none focus:border-fg"
      />
      {#if fieldErrors.name}
        <p class="mt-2 font-mono text-xs uppercase tracking-widest text-danger">
          {fieldErrors.name}
        </p>
      {/if}
    </label>

    <fieldset>
      <legend class="block font-mono text-xs uppercase tracking-widest text-fg/60">
        How's it set up?
      </legend>
      <div class="mt-4 space-y-3">
        {#each BUSINESS_TYPES as bt (bt)}
          <label class="flex cursor-pointer items-center gap-3 text-sm text-fg">
            <input
              type="radio"
              name="businessType"
              value={bt}
              bind:group={businessType}
              required
              class="h-4 w-4 border-fg/30 text-accent focus:ring-accent"
            />
            <span>{BUSINESS_TYPE_LABELS[bt]}</span>
          </label>
        {/each}
      </div>
      {#if fieldErrors.businessType}
        <p class="mt-2 font-mono text-xs uppercase tracking-widest text-danger">
          {fieldErrors.businessType}
        </p>
      {/if}
    </fieldset>

    {#if formError}
      <p class="font-mono text-xs uppercase tracking-widest text-danger">{formError}</p>
    {/if}

    <div class="flex items-center justify-between gap-4">
      <a href="/" class="label hover:text-fg">
        Cancel
      </a>
      <button
        type="submit"
        disabled={submitting}
        class="btn px-6 py-3"
      >
        Create company
      </button>
    </div>
  </form>
</div>
