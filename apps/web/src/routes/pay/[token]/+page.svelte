<script lang="ts">
  import { COLORS, GOOGLE_FONTS_HREF } from '@thalermark/brand';
  import type { Stripe, StripeElements, StripePaymentElement } from '@stripe/stripe-js';
  import { onMount } from 'svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const inv = $derived(data.invoice);

  // Stripe.js + the Payment Element live only on the client. Imported lazily so
  // we don't ship stripe.js until the recipient has actually reached /pay.
  let mountEl: HTMLDivElement | null = $state(null);
  let stripe: Stripe | null = $state(null);
  let elements: StripeElements | null = $state(null);
  let ready = $state(false);
  let submitting = $state(false);
  let payError: string | null = $state(null);

  onMount(async () => {
    const { loadStripe } = await import('@stripe/stripe-js');
    // Direct charges (Connect) put the intent on the connected account, so
    // stripe.js must be initialized in that account's context. Null on the
    // self-host / platform path. This is the fix for the latent missing-
    // stripeAccount bug in the old embedded-checkout flow.
    stripe = await loadStripe(
      data.publishableKey,
      data.stripeAccountId ? { stripeAccount: data.stripeAccountId } : undefined,
    );
    if (!stripe || !mountEl) {
      payError = 'Could not load the payment form. Please refresh and try again.';
      return;
    }

    // Theme the Element to the brand palette so the card form reads as
    // Thalermark, not a generic Stripe widget. Fonts pulled from the same
    // Google Fonts bundle the rest of the app uses.
    elements = stripe.elements({
      clientSecret: data.clientSecret,
      appearance: {
        theme: 'stripe',
        variables: {
          colorPrimary: COLORS.gold.deep,
          colorText: COLORS.ink,
          colorDanger: COLORS.accents.oxblood,
          fontFamily: 'Inter, system-ui, sans-serif',
          borderRadius: '2px',
          spacingUnit: '4px',
        },
      },
      fonts: [{ cssSrc: GOOGLE_FONTS_HREF }],
    });
    const paymentElement: StripePaymentElement = elements.create('payment');
    paymentElement.mount(mountEl);
    ready = true;
  });

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (!stripe || !elements || submitting) return;
    submitting = true;
    payError = null;
    // On success confirmPayment navigates the browser to return_url, so the
    // lines below run only on a confirmation/validation failure.
    const { error: err } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/i/${data.token}?paid=1`,
      },
    });
    payError = err?.message ?? 'Payment could not be completed. Please try again.';
    submitting = false;
  }
</script>

<div class="mx-auto max-w-lg px-6 py-12 sm:py-20">
  <header class="border-b border-fg/10 pb-8">
    <p class="label">
      {inv.companyName ?? 'Payment'}
    </p>
    <h1 class="mt-2 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      Pay {inv.total} {inv.currency}<span class="text-accent">.</span>
    </h1>
    <p class="mt-2 text-sm text-fg/60">Invoice {inv.number}</p>
  </header>

  <form class="mt-10" onsubmit={handleSubmit}>
    <div bind:this={mountEl}></div>
    {#if !ready && !payError}
      <p class="mt-3 text-sm text-fg/60">Loading payment form…</p>
    {/if}
    {#if payError}
      <p class="mt-4 text-sm text-danger">{payError}</p>
    {/if}
    <button
      type="submit"
      disabled={!ready || submitting}
      class="mt-6 w-full rounded-sm bg-inverse px-6 py-3 text-sm font-medium uppercase tracking-widest text-on-inverse transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
    >
      {submitting ? 'Processing…' : `Pay ${inv.total} ${inv.currency}`}
    </button>
  </form>

  <div class="mt-8 text-center">
    <a
      href="/i/{data.token}"
      class="font-mono text-xs uppercase tracking-widest text-fg/40 transition-colors hover:text-fg/70"
    >
      ← Back to invoice
    </a>
  </div>

  <footer
    class="mt-12 border-t border-fg/10 pt-6 text-center font-mono text-xs uppercase tracking-widest text-fg/40"
  >
    Secured by Stripe · Sent via Thalermark
  </footer>
</div>
