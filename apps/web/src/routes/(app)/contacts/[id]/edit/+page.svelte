<script lang="ts">
  import { enhance } from '$app/forms';
  import { untrack } from 'svelte';
  import AddressLookup from '$lib/components/AddressLookup.svelte';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  // On first render, seed values from the loaded contact. On a fail()
  // re-render the user's just-submitted values win so they don't lose
  // their typing — same shape as the create form, just with a different
  // initial source.
  const seed = $derived(form?.values ?? data.contact);
  const fieldErrors = $derived(form?.fieldErrors ?? {});

  type FieldKey =
    | 'name'
    | 'email'
    | 'phone'
    | 'addressLine1'
    | 'addressLine2'
    | 'city'
    | 'region'
    | 'postalCode'
    | 'country'
    | 'notes';

  function v(key: FieldKey): string {
    const raw = (seed as Record<string, unknown>)[key];
    return typeof raw === 'string' ? raw : '';
  }
  function err(key: FieldKey): string | undefined {
    return (fieldErrors as Record<string, string>)[key];
  }

  // Address fields move from uncontrolled value={...} to bind:value so the
  // AddressLookup component can write a picked suggestion across all five.
  // v() already encodes the form?.values → data.contact precedence; reading
  // it via untrack() at $state init captures the SSR-time value without
  // re-triggering on subsequent form prop changes.
  let addressLine1 = $state<string>(untrack(() => v('addressLine1')));
  let addressLine2 = $state<string>(untrack(() => v('addressLine2')));
  let city = $state<string>(untrack(() => v('city')));
  let region = $state<string>(untrack(() => v('region')));
  let postalCode = $state<string>(untrack(() => v('postalCode')));
  let country = $state<string>(untrack(() => v('country')));
</script>

<a href="/contacts/{data.contact.id}" class="eyebrow text-fg/60 hover:text-fg">← {data.contact.name}</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
  Edit contact<span class="text-accent">.</span>
</h1>

{#if form?.formError}
  <div class="mt-6 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    {form.formError}
  </div>
{/if}

<form method="post" class="mt-8 space-y-6" use:enhance>
  <div>
    <label for="name" class="label">
      Name<span class="text-accent">*</span>
    </label>
    <input
      id="name"
      name="name"
      type="text"
      required
      maxlength="200"
      value={v('name')}
      class="field mt-1"
    />
    {#if err('name')}
      <p class="mt-1 text-xs text-danger">{err('name')}</p>
    {/if}
  </div>

  <div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
    <div>
      <label for="email" class="label">Email</label>
      <input
        id="email"
        name="email"
        type="email"
        maxlength="320"
        value={v('email')}
        class="field mt-1"
      />
      {#if err('email')}
        <p class="mt-1 text-xs text-danger">{err('email')}</p>
      {/if}
    </div>
    <div>
      <label for="phone" class="label">Phone</label>
      <input
        id="phone"
        name="phone"
        type="tel"
        maxlength="50"
        value={v('phone')}
        class="field mt-1"
      />
      {#if err('phone')}
        <p class="mt-1 text-xs text-danger">{err('phone')}</p>
      {/if}
    </div>
  </div>

  <fieldset class="space-y-4">
    <legend class="label">Address</legend>
    <AddressLookup
      bind:addressLine1
      bind:city
      bind:region
      bind:postalCode
      bind:country
    />
    <input
      name="addressLine2"
      type="text"
      maxlength="200"
      placeholder="Suite, unit, etc."
      bind:value={addressLine2}
      class="field"
    />
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <input
        name="city"
        type="text"
        maxlength="100"
        placeholder="City"
        bind:value={city}
        class="rounded-sm border border-fg/15 bg-surface-2 px-3 py-2 text-fg focus:border-accent focus:outline-none"
      />
      <input
        name="region"
        type="text"
        maxlength="100"
        placeholder="State / Region"
        bind:value={region}
        class="rounded-sm border border-fg/15 bg-surface-2 px-3 py-2 text-fg focus:border-accent focus:outline-none"
      />
      <input
        name="postalCode"
        type="text"
        maxlength="20"
        placeholder="Postal code"
        bind:value={postalCode}
        class="rounded-sm border border-fg/15 bg-surface-2 px-3 py-2 text-fg focus:border-accent focus:outline-none"
      />
    </div>
    <input
      name="country"
      type="text"
      maxlength="2"
      placeholder="Country (ISO, e.g. US)"
      bind:value={country}
      class="w-32 rounded-sm border border-fg/15 bg-surface-2 px-3 py-2 uppercase text-fg focus:border-accent focus:outline-none"
    />
  </fieldset>

  <div>
    <label for="notes" class="label">Notes</label>
    <textarea
      id="notes"
      name="notes"
      rows="4"
      maxlength="5000"
      class="field mt-1"
      >{v('notes')}</textarea
    >
  </div>

  <div class="flex items-center gap-4">
    <button
      type="submit"
      class="btn"
    >
      Save changes
    </button>
    <a href="/contacts/{data.contact.id}" class="text-sm text-fg/60 hover:text-fg">Cancel</a>
  </div>
</form>
