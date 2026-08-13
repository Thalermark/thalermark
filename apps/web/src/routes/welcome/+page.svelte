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
  // Asked here, next to the address, because this is the only moment everyone
  // passes through — and because the column is notNull default 'UTC', which is
  // silently wrong for almost everyone. It decides what day a document is
  // filed on: an invoice raised at 9pm US Central under UTC is dated tomorrow,
  // and on 31 December that is income in the wrong tax year (TMC-258).
  //
  // Detected from the browser rather than guessed from the address above: that
  // address is free text with no state or postcode to key off, and even
  // structured US addresses do not map cleanly (Florida, Indiana, Tennessee and
  // Kentucky each straddle two zones, Arizona opts out of DST). The browser
  // simply knows.
  //
  // The initial value is the STORED one, deliberately — `Intl` during SSR
  // reports the SERVER's zone, which is UTC in the container and is nobody's
  // answer. Reading it there would render one stranger's timezone as every
  // user's default, and it looks correct in dev only because the dev server is
  // the developer's own laptop. Detection is applied on mount instead, below.
  let timezone = $state(
    untrack(() => formValue('timezone') || data.company.timezone || 'UTC'),
  );

  // Client-only, once. Skipped when the user is coming back from a failed
  // submit with a zone already chosen — their pick outranks the guess.
  let detectionApplied = false;
  $effect(() => {
    if (detectionApplied) return;
    detectionApplied = true;
    if (formValue('timezone')) return;
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detected) timezone = detected;
  });
  // Defaults to the address they signed up with (TMC-225), the same way the
  // company name is guessed from the person at signup and corrected here. It is
  // what customer replies route to, and what prints on the invoice — so it is
  // prefilled and editable rather than assumed silently.
  let businessEmail = $state(
    untrack(
      () => formValue('businessEmail') ?? data.company.businessEmail ?? data.signupEmail ?? '',
    ),
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
      <span class="label">Time zone</span>
      <select name="timezone" bind:value={timezone} class="field mt-2 text-sm">
        {#each data.timezones as tz (tz)}
          <option value={tz}>{tz}</option>
        {/each}
      </select>
      <span class="mt-2 block text-sm text-fg/50">
        Decides what day your invoices and payments are recorded on.
      </span>
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
    <label class="block">
      <span class="label">Business email</span>
      <input
        type="email"
        name="businessEmail"
        bind:value={businessEmail}
        placeholder="hello@yourbusiness.com"
        class="field mt-2 text-sm"
      />
      <span class="mt-1 block text-xs text-fg/50">
        This shows on your invoices so customers can reach you, and it's where their replies go.
      </span>
    </label>
  </div>

  {#if formError}
    <p class="label text-danger">{formError}</p>
  {/if}

  <button type="submit" disabled={submitting} class="btn w-full py-3"> Continue </button>
</form>
