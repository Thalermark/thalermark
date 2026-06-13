<script lang="ts">
  import { enhance } from '$app/forms';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  let submitting = $state(false);
  const formError = $derived(form?.formError as string | undefined);
</script>

<span class="eyebrow">Getting paid</span>
<h1 class="mt-3 font-serif text-3xl font-light leading-tight tracking-tight text-fg">
  How do you want to get paid<span class="text-accent">?</span>
</h1>
<p class="mt-4 text-fg/70">
  These print as instructions on your invoices. You mark them paid yourself when the money lands.
  To accept card payments online, connect Stripe later in
  <span class="font-medium text-fg">Settings → Payments</span>.
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
  class="mt-8 space-y-6"
>
  <input type="hidden" name="companyId" value={data.company.id} />

  <label class="flex items-center gap-3 text-sm text-fg">
    <input
      type="checkbox"
      name="paymentCashEnabled"
      checked={data.company.paymentCashEnabled}
      class="size-4 rounded-sm border-fg/30 text-accent focus:ring-accent"
    />
    Accept cash (in person)
  </label>

  <div class="grid gap-3">
    <label class="flex items-center gap-3 text-sm text-fg">
      <input
        type="checkbox"
        name="paymentCheckEnabled"
        checked={data.company.paymentCheckEnabled}
        class="size-4 rounded-sm border-fg/30 text-accent focus:ring-accent"
      />
      Accept check
    </label>
    <input
      name="paymentCheckPayableTo"
      value={data.company.paymentCheckPayableTo ?? ''}
      placeholder="Make payable to (defaults to {data.company.name})"
      class="field text-sm"
    />
    <textarea
      name="paymentCheckAddress"
      placeholder="Mailing address (optional)"
      rows="2"
      class="field text-sm">{data.company.paymentCheckAddress ?? ''}</textarea
    >
  </div>

  <label class="grid gap-1 text-sm text-fg">
    Venmo handle
    <input
      name="paymentVenmoHandle"
      value={data.company.paymentVenmoHandle ?? ''}
      placeholder="@your-handle"
      class="field"
    />
  </label>

  <label class="grid gap-1 text-sm text-fg">
    Zelle email or phone
    <input
      name="paymentZelleContact"
      value={data.company.paymentZelleContact ?? ''}
      placeholder="you@example.com or 555-0100"
      class="field"
    />
  </label>

  {#if formError}
    <p class="label text-danger">{formError}</p>
  {/if}

  <div class="flex items-center justify-between gap-4 pt-2">
    <a href="/welcome/brand" class="label hover:text-fg"> Skip for now </a>
    <button type="submit" disabled={submitting} class="btn px-6 py-3"> Continue </button>
  </div>
</form>
