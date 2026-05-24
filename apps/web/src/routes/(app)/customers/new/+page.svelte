<script lang="ts">
  import type { PageProps } from './$types';

  let { form }: PageProps = $props();
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
