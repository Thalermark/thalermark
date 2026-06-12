<script lang="ts">
  import { enhance } from '$app/forms';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  let submitting = $state(false);
  const formError = $derived(form?.formError as string | undefined);
</script>

<span class="eyebrow">Getting paid</span>
<h1 class="mt-3 font-serif text-3xl font-light leading-tight tracking-tight text-ink">
  How do you want to get paid<span class="text-gold-deep">?</span>
</h1>
<p class="mt-4 text-ink/70">
  These print as instructions on your invoices. You mark them paid yourself when the money lands.
  To accept card payments online, connect Stripe later in
  <span class="font-medium text-ink">Settings → Payments</span>.
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

  <label class="flex items-center gap-3 text-sm text-ink">
    <input
      type="checkbox"
      name="paymentCashEnabled"
      checked={data.company.paymentCashEnabled}
      class="size-4 rounded-sm border-ink/30 text-gold-deep focus:ring-gold-deep"
    />
    Accept cash (in person)
  </label>

  <div class="grid gap-3">
    <label class="flex items-center gap-3 text-sm text-ink">
      <input
        type="checkbox"
        name="paymentCheckEnabled"
        checked={data.company.paymentCheckEnabled}
        class="size-4 rounded-sm border-ink/30 text-gold-deep focus:ring-gold-deep"
      />
      Accept check
    </label>
    <input
      name="paymentCheckPayableTo"
      value={data.company.paymentCheckPayableTo ?? ''}
      placeholder="Make payable to (defaults to {data.company.name})"
      class="w-full rounded-sm border border-ink/20 bg-cream px-3 py-2 text-sm text-ink focus:border-gold-deep focus:outline-none"
    />
    <textarea
      name="paymentCheckAddress"
      placeholder="Mailing address (optional)"
      rows="2"
      class="w-full rounded-sm border border-ink/20 bg-cream px-3 py-2 text-sm text-ink focus:border-gold-deep focus:outline-none"
      >{data.company.paymentCheckAddress ?? ''}</textarea
    >
  </div>

  <label class="grid gap-1 text-sm text-ink">
    Venmo handle
    <input
      name="paymentVenmoHandle"
      value={data.company.paymentVenmoHandle ?? ''}
      placeholder="@your-handle"
      class="rounded-sm border border-ink/20 bg-cream px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
    />
  </label>

  <label class="grid gap-1 text-sm text-ink">
    Zelle email or phone
    <input
      name="paymentZelleContact"
      value={data.company.paymentZelleContact ?? ''}
      placeholder="you@example.com or 555-0100"
      class="rounded-sm border border-ink/20 bg-cream px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
    />
  </label>

  {#if formError}
    <p class="font-mono text-xs uppercase tracking-widest text-oxblood">{formError}</p>
  {/if}

  <div class="flex items-center justify-between gap-4 pt-2">
    <a
      href="/welcome/brand"
      class="font-mono text-xs uppercase tracking-widest text-ink/50 hover:text-ink"
    >
      Skip for now
    </a>
    <button
      type="submit"
      disabled={submitting}
      class="rounded-sm bg-ink px-6 py-3 text-sm font-medium text-cream transition-colors hover:bg-gold-deep disabled:opacity-50"
    >
      Continue
    </button>
  </div>
</form>
