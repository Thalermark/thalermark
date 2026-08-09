<script lang="ts">
  import { COLORS, BRAND_FONTS_HREF } from '@thalermark/brand';
  import type { Stripe, StripeElements, StripePaymentElement } from '@stripe/stripe-js';
  import { onMount } from 'svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const inv = $derived(data.invoice);
  // Print what Stripe is charging, which is the outstanding balance — the
  // heading and the button used to read the invoice total while the intent was
  // minted for total − paid, so a customer who had already put a deposit down
  // was shown one number and billed another (TMC-210).
  const hasPaid = $derived(Number(inv.paid) > 0);

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
    // Thalermark, not a generic Stripe widget. The Element is an iframe and
    // can't see our CSS vars, so the dark variant is passed explicitly, keyed
    // off the theme the init script resolved (`.dark` on <html>). Fonts come
    // from the same self-hosted stylesheet the rest of the app uses, passed as
    // an absolute URL because Stripe fetches it from inside its own iframe.
    // (In local dev Stripe can't reach a localhost origin, so the card form
    // falls back to a system font — cosmetic only; production serves it fine.)
    const isDark = document.documentElement.classList.contains('dark');
    const fontsHref = new URL(BRAND_FONTS_HREF, window.location.origin).href;
    elements = stripe.elements({
      clientSecret: data.clientSecret,
      appearance: {
        theme: isDark ? 'night' : 'stripe',
        variables: {
          colorPrimary: isDark ? COLORS.gold.DEFAULT : COLORS.gold.deep,
          colorText: isDark ? COLORS.cream.DEFAULT : COLORS.ink,
          colorDanger: isDark ? '#cf7060' : COLORS.accents.oxblood, // lifted oxblood (matches --danger in .dark)
          fontFamily: 'Inter, system-ui, sans-serif',
          borderRadius: '2px',
          spacingUnit: '4px',
          // Match the card surface to navy in dark; leave light to Stripe's default.
          ...(isDark ? { colorBackground: COLORS.navy.DEFAULT } : {}),
        },
      },
      fonts: [{ cssSrc: fontsHref }],
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
      Pay {data.amount} {data.currency}<span class="text-accent">.</span>
    </h1>
    <p class="mt-2 text-sm text-fg/60">Invoice {inv.number}</p>
    {#if hasPaid}
      <p class="mt-1 text-sm text-fg/60">
        Balance due. Invoice total {inv.total} {inv.currency}, {inv.paid} already received.
      </p>
    {/if}
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
      {submitting ? 'Processing…' : `Pay ${data.amount} ${data.currency}`}
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
