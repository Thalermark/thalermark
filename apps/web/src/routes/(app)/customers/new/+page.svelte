<script lang="ts">
  import { untrack } from 'svelte';
  import { findEmailDupe, findNameDupes } from '$lib/customer-dupes';
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
  // existing customer; user can ignore and create anyway. Email match is
  // also enforced server-side as a hard block.
  let nameInput = $state<string>(untrack(() => v('name')));
  let emailInput = $state<string>(untrack(() => v('email')));
  const liveEmailDupe = $derived(findEmailDupe(emailInput, data.customers));
  const liveNameDupes = $derived(findNameDupes(nameInput, data.customers));
</script>

<a href="/customers" class="eyebrow text-ink/60 hover:text-ink">← Customers</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-ink">
  New customer<span class="text-gold-deep">.</span>
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
      bind:value={nameInput}
      class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
    />
    {#if err('name')}
      <p class="mt-1 text-xs text-oxblood">{err('name')}</p>
    {/if}
    {#if liveNameDupes.length > 0}
      <div class="mt-2 rounded-sm border border-ink/10 bg-cream-warm/60 p-2 text-xs">
        <p class="text-ink/60">
          Looks like {liveNameDupes.length === 1 ? 'an existing customer' : 'existing customers'}:
        </p>
        <ul class="mt-1 space-y-1">
          {#each liveNameDupes as dupe (dupe.id)}
            <li class="flex items-center justify-between gap-2">
              <span class="text-ink">{dupe.name}{#if dupe.email}<span class="text-ink/50"> · {dupe.email}</span>{/if}</span>
              <a
                href="/customers/{dupe.id}"
                class="rounded-sm border border-ink/15 bg-cream-warm px-2 py-1 text-xs uppercase tracking-wider text-ink/70 hover:border-gold-deep hover:text-gold-deep"
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
      <label for="email" class="font-mono text-xs uppercase tracking-widest text-ink/50">Email</label>
      <input
        id="email"
        name="email"
        type="email"
        maxlength="320"
        bind:value={emailInput}
        class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
      />
      {#if err('email') && err('email') !== 'email_dupe'}
        <p class="mt-1 text-xs text-oxblood">{err('email')}</p>
      {/if}
      {#if form?.dupeCustomer}
        <div class="mt-2 rounded-sm border border-oxblood/30 bg-oxblood/5 p-3 text-sm">
          <p class="text-ink">
            <span class="font-medium">{form.dupeCustomer.name}</span> already uses this email.
          </p>
          <div class="mt-2 flex flex-wrap items-center gap-3">
            <a
              href="/customers/{form.dupeCustomer.id}"
              class="rounded-sm bg-ink px-3 py-1 text-xs uppercase tracking-wider text-cream hover:bg-gold-deep"
            >
              Open {form.dupeCustomer.name}
            </a>
            <span class="text-xs text-ink/50">or change the email to create a different customer.</span>
          </div>
        </div>
      {:else if liveEmailDupe}
        <div class="mt-2 rounded-sm border border-gold-deep/30 bg-gold-deep/5 p-3 text-sm">
          <p class="text-ink">
            <span class="font-medium">{liveEmailDupe.name}</span> already uses this email.
          </p>
          <a
            href="/customers/{liveEmailDupe.id}"
            class="mt-2 inline-block rounded-sm border border-ink/20 bg-cream-warm px-3 py-1 text-xs uppercase tracking-wider text-ink/70 hover:border-gold-deep hover:text-gold-deep"
          >
            Open {liveEmailDupe.name}
          </a>
        </div>
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
    <input
      name="addressLine1"
      type="text"
      maxlength="200"
      placeholder="Street"
      value={v('addressLine1')}
      class="w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
    />
    <input
      name="addressLine2"
      type="text"
      maxlength="200"
      placeholder="Suite, unit, etc."
      value={v('addressLine2')}
      class="w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
    />
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <input
        name="city"
        type="text"
        maxlength="100"
        placeholder="City"
        value={v('city')}
        class="rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
      />
      <input
        name="region"
        type="text"
        maxlength="100"
        placeholder="State / Region"
        value={v('region')}
        class="rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
      />
      <input
        name="postalCode"
        type="text"
        maxlength="20"
        placeholder="Postal code"
        value={v('postalCode')}
        class="rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
      />
    </div>
    <input
      name="country"
      type="text"
      maxlength="2"
      placeholder="Country (ISO, e.g. US)"
      value={v('country')}
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
      Create customer
    </button>
    <a href="/customers" class="text-sm text-ink/60 hover:text-ink">Cancel</a>
  </div>
</form>
