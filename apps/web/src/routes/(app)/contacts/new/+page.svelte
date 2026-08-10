<script lang="ts">
  import { enhance } from '$app/forms';
  import { enhanceForm } from '$lib/form-enhance';
    import { untrack } from 'svelte';
  import AddressLookup from '$lib/components/AddressLookup.svelte';
  import { findEmailDupe, findNameDupes } from '$lib/contact-dupes';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const values = $derived(form?.values ?? {});
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
    const raw = (values as Record<string, unknown>)[key];
    return typeof raw === 'string' ? raw : '';
  }
  function err(key: FieldKey): string | undefined {
    return (fieldErrors as Record<string, string>)[key];
  }

  // Live dupe-hints (mirrors the inline-create path on /invoices/new).
  // Name match is advisory — shown as a suggestion list with a link to the
  // existing contact; user can ignore and create anyway. Email match is
  // also enforced server-side as a hard block.
  let nameInput = $state<string>(untrack(() => v('name')));
  let emailInput = $state<string>(untrack(() => v('email')));
  const liveEmailDupe = $derived(findEmailDupe(emailInput, data.contacts));
  const liveNameDupes = $derived(findNameDupes(nameInput, data.contacts));

  // Address fields move from uncontrolled value={...} to bind:value so the
  // AddressLookup component can write a picked suggestion across all five.
  // Initial values seed from form?.values via untrack() so a fail()-re-render
  // restores typed-but-not-submitted input — same pattern as 8.4c's
  // line-item rows.
  let addressLine1 = $state<string>(untrack(() => v('addressLine1')));
  let addressLine2 = $state<string>(untrack(() => v('addressLine2')));
  let city = $state<string>(untrack(() => v('city')));
  let region = $state<string>(untrack(() => v('region')));
  let postalCode = $state<string>(untrack(() => v('postalCode')));
  let country = $state<string>(untrack(() => v('country')));
</script>

<a href="/contacts" class="eyebrow text-fg/60 hover:text-fg">← Contacts</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
  New contact<span class="text-accent">.</span>
</h1>

{#if form?.formError}
  <div class="mt-6 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger" data-form-error role="alert" tabindex="-1">
    {form.formError}
  </div>
{/if}

<form method="post" class="mt-8 space-y-6" use:enhance={enhanceForm}>
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
      bind:value={nameInput}
      class="field mt-1"
    />
    {#if err('name')}
      <p class="mt-1 text-xs text-danger">{err('name')}</p>
    {/if}
    {#if liveNameDupes.length > 0}
      <div class="mt-2 rounded-sm border border-fg/10 bg-surface-2/60 p-2 text-xs">
        <p class="text-fg/60">
          Looks like {liveNameDupes.length === 1 ? 'an existing contact' : 'existing contacts'}:
        </p>
        <ul class="mt-1 space-y-1">
          {#each liveNameDupes as dupe (dupe.id)}
            <li class="flex items-center justify-between gap-2">
              <span class="text-fg">{dupe.name}{#if dupe.email}<span class="text-fg/50"> · {dupe.email}</span>{/if}</span>
              <a
                href="/contacts/{dupe.id}"
                class="rounded-sm border border-fg/15 bg-surface-2 px-2 py-1 text-xs uppercase tracking-wider text-fg/70 hover:border-accent hover:text-accent"
              >
                Open
              </a>
            </li>
          {/each}
        </ul>
      </div>
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
        bind:value={emailInput}
        class="field mt-1"
      />
      {#if err('email') && err('email') !== 'email_dupe'}
        <p class="mt-1 text-xs text-danger">{err('email')}</p>
      {/if}
      {#if form?.dupeContact}
        <div class="mt-2 rounded-sm border border-danger/30 bg-danger/5 p-3 text-sm">
          <p class="text-fg">
            <span class="font-medium">{form.dupeContact.name}</span> already uses this email.
          </p>
          <div class="mt-2 flex flex-wrap items-center gap-3">
            <a
              href="/contacts/{form.dupeContact.id}"
              class="rounded-sm bg-inverse px-3 py-1 text-xs uppercase tracking-wider text-on-inverse hover:bg-accent"
            >
              Open {form.dupeContact.name}
            </a>
            <span class="text-xs text-fg/50">or change the email to create a different contact.</span>
          </div>
        </div>
      {:else if liveEmailDupe}
        <div class="mt-2 rounded-sm border border-accent/30 bg-accent/5 p-3 text-sm">
          <p class="text-fg">
            <span class="font-medium">{liveEmailDupe.name}</span> already uses this email.
          </p>
          <a
            href="/contacts/{liveEmailDupe.id}"
            class="mt-2 inline-block rounded-sm border border-fg/20 bg-surface-2 px-3 py-1 text-xs uppercase tracking-wider text-fg/70 hover:border-accent hover:text-accent"
          >
            Open {liveEmailDupe.name}
          </a>
        </div>
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
      Create contact
    </button>
    <a href="/contacts" class="text-sm text-fg/60 hover:text-fg">Cancel</a>
  </div>
</form>
