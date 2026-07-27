<script lang="ts">
  import { enhance } from '$app/forms';
  import { trackEvent } from '$lib/telemetry';
  import { untrack } from 'svelte';
  import { BUSINESS_TYPES, BUSINESS_TYPE_LABELS } from '@thalermark/validation';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  // Re-render seed: a 4xx bounce re-runs load(), so the $state initializers
  // prefer the just-submitted form?.values, falling back to the stored company
  // value then a sensible default (sole-prop preselected). The whole initializer
  // is wrapped in untrack() — these capture the *initial* value on purpose; the
  // inputs are user-controlled after mount, so reading `data`/`form` here must
  // not register a reactive dependency.
  const formValue = (key: string) => (form?.values as Record<string, string> | undefined)?.[key];

  let name = $state(untrack(() => formValue('name') ?? data.company.name ?? ''));
  let businessType = $state(
    untrack(() => formValue('businessType') || data.company.businessType || 'sole_prop'),
  );
  let businessAddress = $state(
    untrack(() => formValue('businessAddress') ?? data.company.businessAddress ?? ''),
  );
  let businessPhone = $state(
    untrack(() => formValue('businessPhone') ?? data.company.businessPhone ?? ''),
  );

  let submitting = $state(false);

  const fieldErrors = $derived((form?.fieldErrors as Record<string, string> | undefined) ?? {});
  const formError = $derived(form?.formError as string | undefined);
</script>

<span class="eyebrow">Welcome</span>
<h1 class="mt-3 font-serif text-3xl font-light leading-tight tracking-tight text-fg">
  Let's set up your business<span class="text-accent">.</span>
</h1>
<p class="mt-4 text-fg/70">
  Just a couple of quick things, then you can send your first invoice. You can change any of this
  later in Settings.
</p>

<form
  method="POST"
  use:enhance={() => {
    submitting = true;
    return ({ result, update }) => {
      // company_setup completes when the business-setup step succeeds (it
      // redirects on to /welcome/paid). onboarding_step_completed's other steps
      // (first_*) are emitted server-side.
      if (result.type === 'redirect') {
        trackEvent({ name: 'onboarding_step_completed', step: 'company_setup' });
      }
      update().finally(() => {
        submitting = false;
      });
    };
  }}
  class="mt-8 space-y-8"
>
  <input type="hidden" name="companyId" value={data.company.id} />

  <label class="block">
    <span class="label">Business name</span>
    <input
      type="text"
      name="name"
      bind:value={name}
      required
      placeholder="e.g. Sunrise Landscaping"
      class="field-line mt-2"
    />
    <span class="mt-1 block font-mono text-xs text-fg/50">This is what your contacts see.</span>
    {#if fieldErrors.name}
      <p class="label mt-2 text-danger">{fieldErrors.name}</p>
    {/if}
  </label>

  <fieldset>
    <legend class="label block">How's your business set up?</legend>
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
      <p class="label mt-2 text-danger">
        {fieldErrors.businessType}
      </p>
    {/if}
  </fieldset>

  <div class="space-y-6 border-t border-fg/10 pt-6">
    <p class="label text-fg/40">
      Optional — shown on your invoices
    </p>
    <label class="block">
      <span class="label">Business address</span>
      <textarea
        name="businessAddress"
        bind:value={businessAddress}
        rows="2"
        placeholder="123 Main St&#10;Springfield, IL 62704"
        class="field mt-2 text-sm"
      ></textarea>
    </label>
    <label class="block">
      <span class="label">Phone</span>
      <input
        type="tel"
        name="businessPhone"
        bind:value={businessPhone}
        placeholder="(555) 123-4567"
        class="field mt-2 text-sm"
      />
    </label>
  </div>

  {#if formError}
    <p class="label text-danger">{formError}</p>
  {/if}

  <button type="submit" disabled={submitting} class="btn w-full py-3"> Continue </button>
</form>
