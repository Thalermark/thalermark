<script lang="ts">
  import { untrack } from 'svelte';
  import AddressLookup from '$lib/components/AddressLookup.svelte';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  // On first render, seed values from the loaded customer. On a fail()
  // re-render the user's just-submitted values win so they don't lose
  // their typing — same shape as the create form, just with a different
  // initial source.
  const seed = $derived(form?.values ?? data.customer);
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
  // v() already encodes the form?.values → data.customer precedence; reading
  // it via untrack() at $state init captures the SSR-time value without
  // re-triggering on subsequent form prop changes.
  let addressLine1 = $state<string>(untrack(() => v('addressLine1')));
  let addressLine2 = $state<string>(untrack(() => v('addressLine2')));
  let city = $state<string>(untrack(() => v('city')));
  let region = $state<string>(untrack(() => v('region')));
  let postalCode = $state<string>(untrack(() => v('postalCode')));
  let country = $state<string>(untrack(() => v('country')));
</script>

<a href="/customers/{data.customer.id}" class="eyebrow text-ink/60 hover:text-ink">← {data.customer.name}</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-ink">
  Edit customer<span class="text-gold-deep">.</span>
</h1>

{#if form?.formError}
  <div class="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3 text-sm text-oxblood">
    {form.formError}
  </div>
{/if}

<form method="post" class="mt-8 space-y-6">
  <div>
    <label for="name" class="font-mono text-xs uppercase tracking-widest text-ink/50">
      Name<span class="text-gold-deep">*</span>
    </label>
    <input
      id="name"
      name="name"
      type="text"
      required
      maxlength="200"
      value={v('name')}
      class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
    />
    {#if err('name')}
      <p class="mt-1 text-xs text-oxblood">{err('name')}</p>
    {/if}
  </div>

  <div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
    <div>
      <label for="email" class="font-mono text-xs uppercase tracking-widest text-ink/50">Email</label>
      <input
        id="email"
        name="email"
        type="email"
        maxlength="320"
        value={v('email')}
        class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
      />
      {#if err('email')}
        <p class="mt-1 text-xs text-oxblood">{err('email')}</p>
      {/if}
    </div>
    <div>
      <label for="phone" class="font-mono text-xs uppercase tracking-widest text-ink/50">Phone</label>
      <input
        id="phone"
        name="phone"
        type="tel"
        maxlength="50"
        value={v('phone')}
        class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
      />
      {#if err('phone')}
        <p class="mt-1 text-xs text-oxblood">{err('phone')}</p>
      {/if}
    </div>
  </div>

  <fieldset class="space-y-4">
    <legend class="font-mono text-xs uppercase tracking-widest text-ink/50">Address</legend>
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
      class="w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
    />
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <input
        name="city"
        type="text"
        maxlength="100"
        placeholder="City"
        bind:value={city}
        class="rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
      />
      <input
        name="region"
        type="text"
        maxlength="100"
        placeholder="State / Region"
        bind:value={region}
        class="rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
      />
      <input
        name="postalCode"
        type="text"
        maxlength="20"
        placeholder="Postal code"
        bind:value={postalCode}
        class="rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
      />
    </div>
    <input
      name="country"
      type="text"
      maxlength="2"
      placeholder="Country (ISO, e.g. US)"
      bind:value={country}
      class="w-32 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 uppercase text-ink focus:border-gold-deep focus:outline-none"
    />
  </fieldset>

  <div>
    <label for="notes" class="font-mono text-xs uppercase tracking-widest text-ink/50">Notes</label>
    <textarea
      id="notes"
      name="notes"
      rows="4"
      maxlength="5000"
      class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
      >{v('notes')}</textarea
    >
  </div>

  <div class="flex items-center gap-4">
    <button
      type="submit"
      class="rounded-sm bg-ink px-5 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
    >
      Save changes
    </button>
    <a href="/customers/{data.customer.id}" class="text-sm text-ink/60 hover:text-ink">Cancel</a>
  </div>
</form>
