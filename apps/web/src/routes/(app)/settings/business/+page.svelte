<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  // Show the just-saved value back after an action, else the stored value from
  // load. Empty string renders as a cleared field. `??` respects a returned
  // `false` flag (only null/undefined falls through to the stored default).
  const address = $derived(form?.businessAddress ?? data.company.businessAddress ?? '');
  const phone = $derived(form?.businessPhone ?? data.company.businessPhone ?? '');
  const email = $derived(form?.businessEmail ?? data.company.businessEmail ?? '');
  // Reply-to is saved by its own action (?/saveReplyTo) with distinct
  // replyToSaved/replyToError flags, so saving it doesn't trip the contact
  // form's "Saved." and vice-versa.
  const replyTo = $derived(form?.replyToEmail ?? data.company.replyToEmail ?? '');
  // Accounting method — stored as cash/accrual, offered in plain words. Cash is
  // the column default and what effectively every sole proprietor files.
  const accountingMethod = $derived(data.company.accountingMethod ?? 'cash');
  // First-year share of a "spread it out" purchase. Half-year is the IRS
  // default and the column default; full_year exists only as an accountant's
  // override for an asset already being depreciated that way elsewhere.
  const depreciationConvention = $derived(data.company.depreciationConvention ?? 'half_year');
  // Reporting timezone. Stored value wins; the browser's zone is only offered
  // as a one-click suggestion when the two disagree, so we never silently
  // change which period someone's figures land in.
  const timezone = $derived(data.company.timezone ?? 'UTC');
  // null = "no local pick yet", so the select follows the stored value —
  // including after a save reloads it. Any user choice takes over from there.
  let picked = $state<string | null>(null);
  const currentTimezone = $derived(picked ?? timezone);
  const detected =
    typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : '';
  const suggestDetected = $derived(!!detected && detected !== currentTimezone);
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
      These show in the &ldquo;from&rdquo; block on the invoices and estimates your contacts see,
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
    <span class="eyebrow">Your time zone</span>
    <p class="mt-2 font-serif text-lg text-fg">{data.company.name}</p>
  </header>
  <form method="POST" action="?/saveTimezone" class="px-6 py-6">
    <input type="hidden" name="companyId" value={data.company.id} />
    <p class="max-w-prose text-sm leading-relaxed text-fg/70">
      Reports count a day from midnight where you are. Get this wrong and a payment taken on the
      evening of 31 December can land in the wrong tax year.
    </p>
    <label class="mt-5 block">
      <span class="label">Time zone</span>
      <select
        name="timezone"
        value={currentTimezone}
        onchange={(e) => {
          picked = e.currentTarget.value;
        }}
        class="mt-2 w-full max-w-md rounded-sm border border-fg/20 bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
      >
        {#each data.timezones as tz (tz)}
          <option value={tz}>{tz}</option>
        {/each}
      </select>
    </label>
    {#if suggestDetected}
      <p class="mt-3 text-sm text-fg/70">
        This browser looks like <strong>{detected}</strong>.
        <button
          type="button"
          class="link"
          onclick={() => {
            picked = detected;
          }}
        >
          Use that instead
        </button>
      </p>
    {/if}
    <div class="mt-5 flex items-center gap-4">
      <button type="submit" class="btn">Save</button>
      {#if form?.timezoneSaved}
        <span class="text-sm text-fg/60">Saved.</span>
      {:else if form?.timezoneError}
        <span class="text-sm text-danger">Couldn't save: {form.timezoneError}</span>
      {/if}
    </div>
  </form>
</section>

<section class="mt-8 rounded-sm border border-fg/15 bg-surface-2">
  <header class="border-b border-fg/10 px-6 py-5">
    <span class="eyebrow">When you count income</span>
    <p class="mt-2 font-serif text-lg text-fg">{data.company.name}</p>
  </header>
  <form method="POST" action="?/saveAccountingMethod" class="px-6 py-6">
    <input type="hidden" name="companyId" value={data.company.id} />
    <p class="max-w-prose text-sm leading-relaxed text-fg/70">
      <!-- Names no specific form: this setting applies whichever return the business
           files, and a corporation would be told about a Schedule C it never files. -->
      This decides which tax year money lands in. Most people count income when they get paid —
      that's the usual choice for freelancers and trades. Only change this if whoever files your
      taxes told you to; switching methods with the IRS isn't something you do casually.
    </p>
    <div class="mt-5 space-y-3">
      <label class="flex items-start gap-3">
        <input
          type="radio"
          name="accountingMethod"
          value="cash"
          checked={accountingMethod === 'cash'}
          class="mt-1"
        />
        <span>
          <span class="block text-sm text-fg">When you get paid</span>
          <span class="block text-xs text-fg/60">
            An invoice you sent in December but got paid for in January counts as January's income.
            Most common.
          </span>
        </span>
      </label>
      <label class="flex items-start gap-3">
        <input
          type="radio"
          name="accountingMethod"
          value="accrual"
          checked={accountingMethod === 'accrual'}
          class="mt-1"
        />
        <span>
          <span class="block text-sm text-fg">When you send the invoice</span>
          <span class="block text-xs text-fg/60">
            That same invoice counts as December's income, even though the money arrived later.
          </span>
        </span>
      </label>
    </div>
    <div class="mt-5 flex items-center gap-4">
      <button type="submit" class="btn">Save</button>
      {#if form?.accountingSaved}
        <span class="text-sm text-fg/60">Saved.</span>
      {:else if form?.accountingError}
        <span class="text-sm text-danger">Couldn't save: {form.accountingError}</span>
      {/if}
    </div>
  </form>
</section>

<section class="mt-8 rounded-sm border border-fg/15 bg-surface-2">
  <header class="border-b border-fg/10 px-6 py-5">
    <span class="eyebrow">Big purchases, first year</span>
    <p class="mt-2 font-serif text-lg text-fg">{data.company.name}</p>
  </header>
  <form method="POST" action="?/saveDepreciationConvention" class="px-6 py-6">
    <input type="hidden" name="companyId" value={data.company.id} />
    <p class="max-w-prose text-sm leading-relaxed text-fg/70">
      When you buy something big and choose to spread the cost out, this decides how much of it
      counts in the year you bought it. The standard answer is half — the IRS treats anything you
      buy as though you bought it mid-year, whether that was January or December. Only change this
      if whoever files your taxes told you to.
    </p>
    <div class="mt-5 space-y-3">
      <label class="flex items-start gap-3">
        <input
          type="radio"
          name="depreciationConvention"
          value="half_year"
          checked={depreciationConvention === 'half_year'}
          class="mt-1"
        />
        <span>
          <span class="block text-sm text-fg">Half the usual amount</span>
          <span class="block text-xs text-fg/60">
            A $3,600 mower over five years counts about $360 the year you buy it, then about $720 a
            year, with the last half landing in a sixth year. Standard.
          </span>
        </span>
      </label>
      <label class="flex items-start gap-3">
        <input
          type="radio"
          name="depreciationConvention"
          value="full_year"
          checked={depreciationConvention === 'full_year'}
          class="mt-1"
        />
        <span>
          <span class="block text-sm text-fg">The full amount</span>
          <span class="block text-xs text-fg/60">
            That same mower counts about $720 every year for five years, starting the year you buy
            it. Pick this only to match how an accountant is already handling it.
          </span>
        </span>
      </label>
    </div>
    <p class="mt-4 max-w-prose text-xs leading-relaxed text-fg/50">
      Changing this only affects years that haven't been counted yet — anything already on the books
      stays as it was recorded.
    </p>
    <div class="mt-5 flex items-center gap-4">
      <button type="submit" class="btn">Save</button>
      {#if form?.depreciationSaved}
        <span class="text-sm text-fg/60">Saved.</span>
      {:else if form?.depreciationError}
        <span class="text-sm text-danger">Couldn't save: {form.depreciationError}</span>
      {/if}
    </div>
  </form>
</section>

<section class="mt-8 rounded-sm border border-fg/15 bg-surface-2">
  <header class="border-b border-fg/10 px-6 py-5">
    <span class="eyebrow">Reply-to address</span>
    <p class="mt-2 font-serif text-lg text-fg">{data.company.name}</p>
  </header>
  <form method="POST" action="?/saveReplyTo" class="px-6 py-6">
    <input type="hidden" name="companyId" value={data.company.id} />
    <p class="max-w-prose text-sm leading-relaxed text-fg/70">
      Invoices and estimates go out under your business name, but from Thalermark's sending address.
      Set a reply-to so when a contact hits "reply," it reaches you. Leave it blank to send with no
      reply-to.
    </p>
    <label class="mt-5 block">
      <span class="label">Reply-to email</span>
      <input
        type="email"
        name="replyToEmail"
        value={replyTo}
        placeholder="you@yourbusiness.com"
        class="mt-2 w-full max-w-md rounded-sm border border-fg/20 bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
      />
    </label>
    <div class="mt-5 flex items-center gap-4">
      <button type="submit" class="btn">Save</button>
      {#if form?.replyToSaved}
        <span class="text-sm text-fg/60">Saved.</span>
      {:else if form?.replyToError}
        <span class="text-sm text-danger">Couldn't save: {form.replyToError}</span>
      {/if}
    </div>
  </form>
</section>

<section class="mt-8 rounded-sm border border-fg/15 bg-surface-2">
  <header class="border-b border-fg/10 px-6 py-5">
    <span class="eyebrow">Logo</span>
    <p class="mt-2 text-sm text-fg/70">
      Shown on the invoices and estimates your contacts see. PNG, JPEG, or WebP, up to 2&nbsp;MB.
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
