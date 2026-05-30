<script lang="ts">
  import { enhance } from '$app/forms';
  import { untrack } from 'svelte';
  import { BUSINESS_TYPES } from '@thalermark/validation';

  let { data, form } = $props();

  const BUSINESS_TYPE_LABELS: Record<(typeof BUSINESS_TYPES)[number], string> = {
    sole_prop: 'Sole proprietor',
    llc_single_member: 'LLC (single-member)',
    partnership: 'Partnership',
    s_corp: 'S-Corporation',
    c_corp: 'C-Corporation',
  };

  // Re-render seed pattern (same as the customer/invoice forms): a 4xx
  // bounce re-runs load(), so $state initializers read form?.values via
  // untrack() so typed-but-not-submitted input survives the round trip.
  let businessType = $state(
    untrack(
      () => (form?.values as { businessType?: string } | undefined)?.businessType ?? '',
    ),
  );
  let name = $state(
    untrack(() => (form?.values as { name?: string } | undefined)?.name ?? ''),
  );

  let submitting = $state(false);

  const fieldErrors = $derived(
    (form?.fieldErrors as Record<string, string> | undefined) ?? {},
  );
  const formError = $derived(form?.formError as string | undefined);
</script>

<span class="eyebrow">Set up</span>
<h1 class="mt-3 font-serif text-3xl font-light leading-tight tracking-tight text-ink">
  One quick thing<span class="text-gold-deep">.</span>
</h1>
<p class="mt-4 max-w-xl text-ink/70">
  Pick your business type and confirm the company name. We'll use this when it's time to
  hand books to an accountant; you can change it later from settings.
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
  class="mt-8 max-w-xl space-y-8"
>
  <input type="hidden" name="companyId" value={data.company.id} />

  <fieldset>
    <legend class="block font-mono text-xs uppercase tracking-widest text-ink/60">
      Business type
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

  <label class="block">
    <span class="block font-mono text-xs uppercase tracking-widest text-ink/60">
      Company name
    </span>
    <input
      type="text"
      name="name"
      bind:value={name}
      placeholder={data.company.name}
      class="mt-2 w-full border-b border-ink/30 bg-transparent py-2 text-ink outline-none focus:border-ink"
    />
    <span class="mt-1 block font-mono text-xs text-ink/50">
      Leave blank to keep "{data.company.name}".
    </span>
    {#if fieldErrors.name}
      <p class="mt-2 font-mono text-xs uppercase tracking-widest text-oxblood">
        {fieldErrors.name}
      </p>
    {/if}
  </label>

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
