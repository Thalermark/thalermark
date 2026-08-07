<script lang="ts">
  import { BUSINESS_TYPES, BUSINESS_TYPE_LABELS } from '@thalermark/validation';
  import { untrack } from 'svelte';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  // How the business is set up. Picked during onboarding, changeable here —
  // saving it re-maps the company's categories onto the return that entity
  // files. Falls back to sole prop, which is what the signup seed assumes.
  const businessType = $derived(data.company.businessType ?? 'sole_prop');

  // Whether this business has stopped trading. Closing is a two-click action —
  // it's easily reversed, but it changes what the app will let you record, so it
  // shouldn't happen on a stray click.
  let confirmingUndo = $state(false);
  const retired = $derived(data.company.retiredAt != null);
  const retiredOn = $derived(data.company.retiredAt?.slice(0, 10) ?? '');
  let confirmingRetire = $state(false);

  // Which type the radios currently show, so the EIN question appears the moment
  // the answer starts to matter rather than after a round trip.
  let pickedType = $state(untrack(() => data.company.businessType ?? 'sole_prop'));
  const typeChanged = $derived(!retired && pickedType !== businessType);

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
  const vehicleExpenseMethod = $derived(data.company.vehicleExpenseMethod ?? 'standard');
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
    <span class="eyebrow">How your business is set up</span>
    <p class="mt-2 font-serif text-lg text-fg">{data.company.name}</p>
  </header>
  <form method="POST" action="?/saveBusinessType" class="px-6 py-6">
    <input type="hidden" name="companyId" value={data.company.id} />
    <p class="max-w-prose text-sm leading-relaxed text-fg/70">
      You told us this when you set up. If it's changed — you've incorporated, or taken on a partner
      — update it here and we'll adjust your categories to match.
    </p>
    <div class="mt-5 space-y-3">
      {#each BUSINESS_TYPES as bt (bt)}
        <label class="flex cursor-pointer items-center gap-3 text-sm text-fg">
          <input
            type="radio"
            name="businessType"
            value={bt}
            checked={businessType === bt}
            onchange={() => (pickedType = bt)}
            disabled={retired}
          />
          <span>{BUSINESS_TYPE_LABELS[bt]}</span>
        </label>
      {/each}
    </div>

    <!-- The question the app cannot answer for them, asked the moment the answer
         matters. A business type change and a NEW LEGAL ENTITY are different
         things: an LLC electing S-corp status keeps its EIN and is genuinely
         just a re-map, while incorporating creates a different taxpayer whose
         books have to start clean. Guessing from the transition would be wrong
         for the election case, which is the common one. -->
    {#if typeChanged}
      <div class="mt-6 rounded-sm border border-accent/30 bg-accent/5 px-5 py-4">
        <p class="text-sm font-medium text-fg">
          Did you register this as a new business — a new EIN from the IRS?
        </p>
        <p class="mt-2 max-w-prose text-sm leading-relaxed text-fg/70">
          If you set up a company with its own tax ID, it's a separate business as far as the tax
          office is concerned, and it needs its own set of books. If you only changed how the same
          business is taxed, nothing else has to move.
        </p>
        <div class="mt-4 flex flex-wrap items-center gap-4">
          <a href="/companies/handoff?type={pickedType}" class="btn">
            Yes — set up the new business
          </a>
          <button type="submit" class="link text-sm">
            No — same business, just update my categories
          </button>
        </div>
      </div>
    {:else}
      <div class="mt-5 flex items-center gap-4">
        <button type="submit" class="btn" disabled={retired}>Save</button>
        {#if form?.businessTypeSaved}
          <span class="text-sm text-fg/60">Saved.</span>
        {:else if form?.businessTypeError}
          <span class="text-sm text-danger">Couldn't save: {form.businessTypeError}</span>
        {/if}
      </div>
    {/if}
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
      This is about timing — which year a payment counts for. Most people count it when the money
      actually turns up, and that's the usual choice for freelancers and trades. Only change it if
      whoever does your taxes tells you to; switching is a bigger deal with the IRS than it looks.
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

<!--
  Vehicle costs (TMC-179). Sits next to the depreciation convention deliberately:
  the two interact — standard mileage already absorbs the depreciation on the
  vehicle, so claiming both is a double deduction.
-->
<section class="mt-8 rounded-sm border border-fg/15 bg-surface-2">
  <header class="border-b border-fg/10 px-6 py-5">
    <span class="eyebrow">Vehicle costs</span>
    <p class="mt-2 font-serif text-lg text-fg">{data.company.name}</p>
  </header>
  <form method="POST" action="?/saveVehicleExpenseMethod" class="px-6 py-6">
    <input type="hidden" name="companyId" value={data.company.id} />
    <p class="max-w-prose text-sm leading-relaxed text-fg/70">
      The IRS lets you deduct driving one of two ways, and you have to pick one. Most people in your
      line of work are better off with the flat rate per mile — it needs nothing but a log of your
      trips.
    </p>
    <div class="mt-5 space-y-3">
      <label class="flex items-start gap-3">
        <input
          type="radio"
          name="vehicleExpenseMethod"
          value="standard"
          checked={vehicleExpenseMethod === 'standard'}
          class="mt-1"
        />
        <span>
          <span class="block text-sm text-fg">A flat rate for every business mile</span>
          <span class="block text-xs text-fg/60">
            Log your trips on the Mileage page and we'll work out what they're worth. The rate
            already covers your gas, repairs, insurance and the truck's depreciation, so don't claim
            those separately as well.
          </span>
        </span>
      </label>
      <label class="flex items-start gap-3">
        <input
          type="radio"
          name="vehicleExpenseMethod"
          value="actual"
          checked={vehicleExpenseMethod === 'actual'}
          class="mt-1"
        />
        <span>
          <span class="block text-sm text-fg">What the vehicle actually cost me</span>
          <span class="block text-xs text-fg/60">
            Your real gas, repairs and insurance, scaled to how much of your driving was for work.
            We can't total that up for you — we don't know which repairs were the truck's or what
            share of your driving was business — so your mileage log stays a record only, and this
            line is one you'll fill in yourself.
          </span>
        </span>
      </label>
    </div>
    <p class="mt-4 max-w-prose text-xs leading-relaxed text-fg/50">
      Worth knowing before you switch: once you've claimed actual costs on a vehicle you usually
      can't move it back to the flat rate later. If you're unsure, ask whoever files your taxes.
    </p>
    <div class="mt-5 flex items-center gap-4">
      <button type="submit" class="btn">Save</button>
      {#if form?.vehicleMethodSaved}
        <span class="text-sm text-fg/60">Saved.</span>
      {:else if form?.vehicleMethodError}
        <span class="text-sm text-danger">Couldn't save: {form.vehicleMethodError}</span>
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

<!-- Undoing a handoff. Sits above the close section because it is the more
     specific thing: someone reading "this business took over from X" and
     realising that was wrong wants the way back right there, not after a
     paragraph about closing.

     Framed as "undo", never "delete". Nothing is deleted — the entries stay and
     net to zero, which is what an append-only ledger means. -->
{#if data.handoff}
  <section class="mt-8 rounded-sm border border-fg/15 bg-surface-2">
    <header class="border-b border-fg/10 px-6 py-5">
      <span class="eyebrow">Took over from another business</span>
      <p class="mt-2 text-sm text-fg/70">
        {data.company.name} took over from
        <strong class="font-medium text-fg"
          >{data.handoff.predecessorName ?? 'another business'}</strong
        >
        on <span class="font-mono tabular-nums text-fg">{data.handoff.effectiveDate}</span>.
      </p>
    </header>
    <div class="px-6 py-6">
      {#if data.handoff.reversible}
        <p class="max-w-prose text-sm leading-relaxed text-fg/70">
          Set this up by mistake, or got the date wrong? Undo it and everything goes back —
          {data.handoff.predecessorName ?? 'the old business'} reopens with what it had, and this one
          closes. You can then set it up again properly.
        </p>
        {#if confirmingUndo}
          <p class="mt-4 max-w-prose text-sm leading-relaxed text-fg/80">
            Undo the handover? {data.handoff.predecessorName ?? 'The old business'} starts trading
            again and {data.company.name} closes.
          </p>
          <div class="mt-4 flex items-center gap-4">
            <form method="POST" action="?/undoHandoff">
              <input type="hidden" name="transferId" value={data.handoff.id} />
              <button type="submit" class="btn">Yes, undo it</button>
            </form>
            <button
              type="button"
              class="text-sm text-fg/60 hover:text-fg"
              onclick={() => (confirmingUndo = false)}
            >
              Cancel
            </button>
          </div>
        {:else}
          <button
            type="button"
            class="mt-4 rounded-sm border border-fg/20 px-3 py-1.5 text-sm text-fg/70 transition-colors hover:border-accent/40 hover:text-fg"
            onclick={() => (confirmingUndo = true)}
          >
            Undo this handover
          </button>
        {/if}
      {:else}
        <p class="max-w-prose text-sm leading-relaxed text-fg/60">
          You've already recorded work against {data.company.name}, so the handover can't be undone —
          those records need the position it opened with.
        </p>
      {/if}
      {#if form?.handoffError}
        <p class="mt-3 text-sm text-danger">{form.handoffError}</p>
      {/if}
    </div>
  </section>
{/if}

<!-- Closing a business is deliberately last on the page, and deliberately not
     styled as a danger zone: it is a normal thing that happens to a business,
     not a destructive action. Nothing is deleted and nothing is hidden — the
     records stay because they still have to be filed. -->
<section class="mt-8 rounded-sm border border-fg/15 bg-surface-2">
  <header class="border-b border-fg/10 px-6 py-5">
    <span class="eyebrow">{retired ? 'Closed business' : 'Closing this business'}</span>
    <p class="mt-2 text-sm text-fg/70">
      {#if retired}
        You closed this business. Its records are all still here and every report still works —
        you just can't record new work against it.
      {:else}
        If you've stopped trading as <strong class="font-medium text-fg">{data.company.name}</strong
        >, close it here. Everything you've recorded stays put and stays reportable, so you can
        still file for it. You just won't be able to record new work against it — though you can
        still take payment on invoices you'd already sent.
      {/if}
    </p>
  </header>
  <div class="px-6 py-6">
    {#if retired}
      <p class="text-sm text-fg/60">
        Closed on <span class="font-mono tabular-nums text-fg">{retiredOn}</span>.
      </p>
      <form method="POST" action="?/unretire" class="mt-4">
        <input type="hidden" name="companyId" value={data.company.id} />
        <button type="submit" class="btn">Reopen this business</button>
      </form>
    {:else if confirmingRetire}
      <p class="max-w-prose text-sm leading-relaxed text-fg/80">
        Close <strong class="font-medium text-fg">{data.company.name}</strong>? You can reopen it
        from this page if you change your mind.
      </p>
      <div class="mt-4 flex items-center gap-4">
        <form method="POST" action="?/retire">
          <input type="hidden" name="companyId" value={data.company.id} />
          <button type="submit" class="btn">Yes, close it</button>
        </form>
        <button type="button" class="text-sm text-fg/60 hover:text-fg" onclick={() => (confirmingRetire = false)}>
          Cancel
        </button>
      </div>
    {:else}
      <button
        type="button"
        class="rounded-sm border border-fg/20 px-3 py-1.5 text-sm text-fg/70 transition-colors hover:border-accent/40 hover:text-fg"
        onclick={() => (confirmingRetire = true)}
      >
        Close this business
      </button>
    {/if}
    {#if form?.retireError}
      <p class="mt-3 text-sm text-danger">{form.retireError}</p>
    {/if}
  </div>
</section>
