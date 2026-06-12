<script lang="ts">
  import { enhance } from '$app/forms';
  import { untrack } from 'svelte';
  import { BUSINESS_TYPES } from '@thalermark/validation';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  // Friendly labels — business *structure*, not accounting jargon. Sole prop is
  // worded as "Just me" because that's how a solo tradesperson thinks of it.
  const BUSINESS_TYPE_LABELS: Record<(typeof BUSINESS_TYPES)[number], string> = {
    sole_prop: 'Just me (sole proprietor)',
    llc_single_member: 'LLC (single-member)',
    partnership: 'Partnership',
    s_corp: 'S-Corporation',
    c_corp: 'C-Corporation',
  };

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
<h1 class="mt-3 font-serif text-3xl font-light leading-tight tracking-tight text-ink">
  Let's set up your business<span class="text-gold-deep">.</span>
</h1>
<p class="mt-4 text-ink/70">
  Just a couple of quick things, then you can send your first invoice. You can change any of this
  later in Settings.
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
  <input type="hidden" name="companyId" value={data.company.id} />

  <label class="block">
    <span class="font-mono text-xs uppercase tracking-widest text-ink/60">Business name</span>
    <input
      type="text"
      name="name"
      bind:value={name}
      required
      placeholder="e.g. Sunrise Landscaping"
      class="mt-2 w-full border-b border-ink/30 bg-transparent py-2 text-ink outline-none focus:border-ink"
    />
    <span class="mt-1 block font-mono text-xs text-ink/50">This is what your customers see.</span>
    {#if fieldErrors.name}
      <p class="mt-2 font-mono text-xs uppercase tracking-widest text-oxblood">{fieldErrors.name}</p>
    {/if}
  </label>

  <fieldset>
    <legend class="block font-mono text-xs uppercase tracking-widest text-ink/60">
      How's your business set up?
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

  <div class="space-y-6 border-t border-ink/10 pt-6">
    <p class="font-mono text-xs uppercase tracking-widest text-ink/40">
      Optional — shown on your invoices
    </p>
    <label class="block">
      <span class="font-mono text-xs uppercase tracking-widest text-ink/60">Business address</span>
      <textarea
        name="businessAddress"
        bind:value={businessAddress}
        rows="2"
        placeholder="123 Main St&#10;Springfield, IL 62704"
        class="mt-2 w-full rounded-sm border border-ink/20 bg-cream px-3 py-2 text-sm text-ink outline-none focus:border-gold-deep"
      ></textarea>
    </label>
    <label class="block">
      <span class="font-mono text-xs uppercase tracking-widest text-ink/60">Phone</span>
      <input
        type="tel"
        name="businessPhone"
        bind:value={businessPhone}
        placeholder="(555) 123-4567"
        class="mt-2 w-full rounded-sm border border-ink/20 bg-cream px-3 py-2 text-sm text-ink outline-none focus:border-gold-deep"
      />
    </label>
  </div>

  {#if formError}
    <p class="font-mono text-xs uppercase tracking-widest text-oxblood">{formError}</p>
  {/if}

  <button
    type="submit"
    disabled={submitting}
    class="w-full rounded-sm bg-ink px-3 py-3 text-sm font-medium text-cream transition-colors hover:bg-gold-deep disabled:opacity-50"
  >
    Continue
  </button>
</form>
