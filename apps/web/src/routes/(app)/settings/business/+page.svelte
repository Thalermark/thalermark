<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  // Show the just-saved value back after an action, else the stored value from
  // load. Empty string renders as a cleared field. `??` respects a returned
  // `false` flag (only null/undefined falls through to the stored default).
  const address = $derived(form?.businessAddress ?? data.company.businessAddress ?? '');
  const phone = $derived(form?.businessPhone ?? data.company.businessPhone ?? '');
  const email = $derived(form?.businessEmail ?? data.company.businessEmail ?? '');
  // Per-field show defaults, split by document type (invoice vs estimate).
  const showAddressInvoice = $derived(
    form?.showAddressOnInvoice ?? data.company.showAddressOnInvoice ?? true,
  );
  const showPhoneInvoice = $derived(
    form?.showPhoneOnInvoice ?? data.company.showPhoneOnInvoice ?? true,
  );
  const showEmailInvoice = $derived(
    form?.showEmailOnInvoice ?? data.company.showEmailOnInvoice ?? true,
  );
  const showAddressEstimate = $derived(
    form?.showAddressOnEstimate ?? data.company.showAddressOnEstimate ?? true,
  );
  const showPhoneEstimate = $derived(
    form?.showPhoneOnEstimate ?? data.company.showPhoneOnEstimate ?? true,
  );
  const showEmailEstimate = $derived(
    form?.showEmailOnEstimate ?? data.company.showEmailOnEstimate ?? true,
  );
</script>

<h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
  Business<span class="text-accent">.</span>
</h1>

<section class="mt-8 rounded-sm border border-fg/15 bg-surface-2">
  <header class="border-b border-fg/10 px-6 py-5">
    <span class="eyebrow">Address &amp; contact</span>
    <p class="mt-2 font-serif text-lg text-fg">{data.company.name}</p>
  </header>
  <form method="POST" action="?/save" class="px-6 py-7">
    <input type="hidden" name="companyId" value={data.company.id} />
    <p class="max-w-prose text-sm leading-relaxed text-fg/70">
      These show in the &ldquo;from&rdquo; block on the invoices and estimates your customers see,
      under your business name. The checkboxes set the default for new documents &mdash; you can
      still change it on any individual invoice or estimate. Leave a field blank to omit it entirely.
    </p>

    <div class="mt-8 space-y-8">
      <div>
        <label for="businessAddress" class="label block">Business address</label>
        <textarea
          id="businessAddress"
          name="businessAddress"
          rows="3"
          placeholder="123 Main St&#10;Springfield, IL 62704"
          class="mt-2 w-full max-w-md rounded-sm border border-fg/20 bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
          >{address}</textarea
        >
        <div class="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          <label class="flex items-center gap-2 text-sm text-fg/70">
            <input
              type="checkbox"
              name="showAddressOnInvoice"
              checked={showAddressInvoice}
              class="size-4 rounded-sm border-fg/30 text-accent focus:ring-accent"
            />
            Show on invoices
          </label>
          <label class="flex items-center gap-2 text-sm text-fg/70">
            <input
              type="checkbox"
              name="showAddressOnEstimate"
              checked={showAddressEstimate}
              class="size-4 rounded-sm border-fg/30 text-accent focus:ring-accent"
            />
            Show on estimates
          </label>
        </div>
      </div>

      <div>
        <label for="businessPhone" class="label block">Phone</label>
        <input
          id="businessPhone"
          type="tel"
          name="businessPhone"
          value={phone}
          placeholder="(555) 123-4567"
          class="mt-2 w-full max-w-md rounded-sm border border-fg/20 bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
        />
        <div class="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          <label class="flex items-center gap-2 text-sm text-fg/70">
            <input
              type="checkbox"
              name="showPhoneOnInvoice"
              checked={showPhoneInvoice}
              class="size-4 rounded-sm border-fg/30 text-accent focus:ring-accent"
            />
            Show on invoices
          </label>
          <label class="flex items-center gap-2 text-sm text-fg/70">
            <input
              type="checkbox"
              name="showPhoneOnEstimate"
              checked={showPhoneEstimate}
              class="size-4 rounded-sm border-fg/30 text-accent focus:ring-accent"
            />
            Show on estimates
          </label>
        </div>
      </div>

      <div>
        <label for="businessEmail" class="label block">Email</label>
        <input
          id="businessEmail"
          type="email"
          name="businessEmail"
          value={email}
          placeholder="hello@yourbusiness.com"
          class="mt-2 w-full max-w-md rounded-sm border border-fg/20 bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
        />
        <div class="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          <label class="flex items-center gap-2 text-sm text-fg/70">
            <input
              type="checkbox"
              name="showEmailOnInvoice"
              checked={showEmailInvoice}
              class="size-4 rounded-sm border-fg/30 text-accent focus:ring-accent"
            />
            Show on invoices
          </label>
          <label class="flex items-center gap-2 text-sm text-fg/70">
            <input
              type="checkbox"
              name="showEmailOnEstimate"
              checked={showEmailEstimate}
              class="size-4 rounded-sm border-fg/30 text-accent focus:ring-accent"
            />
            Show on estimates
          </label>
        </div>
      </div>
    </div>

    <div class="mt-8 flex items-center gap-4">
      <button
        type="submit"
        class="btn"
      >
        Save
      </button>
      {#if form?.saved}
        <span class="text-sm text-fg/60">Saved.</span>
      {:else if form?.error}
        <span class="text-sm text-danger">Couldn't save: {form.error}</span>
      {/if}
    </div>
  </form>
</section>

<section class="mt-8 rounded-sm border border-fg/15 bg-surface-2">
  <header class="border-b border-fg/10 px-6 py-5">
    <span class="eyebrow">Logo</span>
    <p class="mt-2 text-sm text-fg/70">
      Shown on the invoices and estimates your customers see. PNG, JPEG, or WebP, up to 2&nbsp;MB.
    </p>
  </header>
  <div class="px-6 py-6">
    {#if data.logo}
      <img
        src={data.logo.url}
        alt="Current logo"
        class="max-h-24 max-w-[16rem] rounded-sm border border-fg/10 bg-surface object-contain p-2"
      />
      <form method="POST" action="?/removeLogo" class="mt-4">
        <input type="hidden" name="companyId" value={data.company.id} />
        <button
          type="submit"
          class="rounded-sm border border-fg/20 px-3 py-1.5 text-sm text-fg/70 transition-colors hover:border-danger/40 hover:text-danger"
        >
          Remove logo
        </button>
      </form>
    {:else}
      <p class="text-sm text-fg/50">No logo yet.</p>
    {/if}

    <form
      method="POST"
      action="?/uploadLogo"
      enctype="multipart/form-data"
      class="mt-5 flex flex-wrap items-center gap-3"
    >
      <input type="hidden" name="companyId" value={data.company.id} />
      <input
        type="file"
        name="logo"
        accept="image/png,image/jpeg,image/webp"
        class="text-sm text-fg/70 file:mr-3 file:rounded-sm file:border-0 file:bg-inverse file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-on-inverse hover:file:bg-accent"
      />
      <button
        type="submit"
        class="btn"
      >
        {data.logo ? 'Replace' : 'Upload'}
      </button>
    </form>
    {#if form?.logoError}
      <p class="mt-3 text-sm text-danger">{form.logoError}</p>
    {/if}
  </div>
</section>
