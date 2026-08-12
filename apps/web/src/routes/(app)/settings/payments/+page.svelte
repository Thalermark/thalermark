<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  // The four states the page distinguishes:
  //   notStarted  — no stripe_connect_account_id yet, Connect button kicks off Express onboarding
  //   started     — account exists but details_submitted is still false: they opened Stripe's
  //                 form and backed out, so there is nothing in review yet
  //   inReview    — details_submitted but not yet charges_enabled, Stripe is verifying
  //   enabled     — charges_enabled, contacts can pay this company
  // started and inReview are both "can't take card payments yet" but they need opposite
  // copy: one is waiting on the user, the other on Stripe. Deriving the stage from the
  // account id alone collapsed them and told abandoners their details were under review.
  // stripeNotConfigured is a separate state: the operator hasn't wired
  // STRIPE_* env vars (self-host without payments), nothing to do here.
  const stripeConfigured = $derived(data.status.stripeConfigured);
  const stage = $derived(
    !data.status.stripeConnectAccountId
      ? 'notStarted'
      : data.status.stripeConnectChargesEnabled
        ? 'enabled'
        : data.status.stripeConnectDetailsSubmitted
          ? 'inReview'
          : 'started',
  );
  const buttonLabel = $derived(
    stage === 'notStarted'
      ? 'Connect with Stripe'
      : stage === 'started'
        ? 'Continue onboarding'
        : stage === 'inReview'
          ? 'Update details with Stripe'
          : 'Update payout details',
  );
</script>

<h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
  Accept payments<span class="text-accent">.</span>
</h1>

{#if data.stripeReturn === 'return'}
  <div class="mt-6 rounded-sm border border-accent/40 bg-accent/10 px-5 py-4 text-sm text-fg/80">
    Welcome back from Stripe. Your onboarding status below reflects the latest from them — if it
    still says "in review," Stripe is finishing their verification and will email you when you're
    fully enabled.
  </div>
{/if}

{#if !stripeConfigured}
  <div class="mt-8 rounded-sm border border-fg/15 bg-surface-2 px-6 py-5">
    <p class="font-serif text-lg text-fg">Stripe isn't configured.</p>
    <p class="mt-2 text-sm text-fg/70">
      This installation hasn't wired Stripe API keys, so payment collection is unavailable. Set the
      <span class="font-mono text-xs">STRIPE_*</span> environment variables on the server to enable
      it.
    </p>
  </div>
{:else}
  <section class="mt-8 rounded-sm border border-fg/15 bg-surface-2">
    <header class="border-b border-fg/10 px-6 py-5">
      <span class="eyebrow">Stripe Connect</span>
      <p class="mt-2 font-serif text-lg text-fg">
        {data.company.name}
      </p>
    </header>
    <div class="grid gap-6 px-6 py-6 sm:grid-cols-[1fr_auto] sm:items-center">
      <div>
        {#if stage === 'notStarted'}
          <p class="text-sm text-fg/70">
            Connect a Stripe account so contacts can pay your invoices online. Stripe runs the
            onboarding — bank, ID, the lot. Takes a few minutes.
          </p>
        {:else if stage === 'started'}
          <p class="text-sm text-fg/70">
            You started setting up with Stripe but didn't finish, so card payments are still off.
            Nothing's lost — pick up where you left off and Stripe will keep what you've entered.
          </p>
        {:else if stage === 'inReview'}
          <p class="text-sm text-fg/70">
            Your details are with Stripe. They're verifying everything and will switch payments on
            automatically when they're done — no further action needed unless they email you.
          </p>
        {:else}
          <p class="text-sm text-fg/70">
            Payments are live. Contacts can pay invoices using the pay link on the public invoice
            page.
          </p>
        {/if}
        <dl class="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 label">
          <dt>Details submitted</dt>
          <dd class="text-fg/80">{data.status.stripeConnectDetailsSubmitted ? 'yes' : 'no'}</dd>
          <dt>Charges enabled</dt>
          <dd class="text-fg/80">{data.status.stripeConnectChargesEnabled ? 'yes' : 'no'}</dd>
        </dl>
      </div>
      <form method="POST" action="?/onboard">
        <input type="hidden" name="companyId" value={data.company.id} />
        <button
          type="submit"
          class="btn"
        >
          {buttonLabel}
        </button>
      </form>
    </div>
    {#if form?.onboardError}
      <p class="border-t border-fg/10 px-6 py-3 text-sm text-danger">
        Couldn't start onboarding: {form.onboardError}
      </p>
    {/if}
  </section>
{/if}

<section class="mt-8 rounded-sm border border-fg/15 bg-surface-2">
  <header class="border-b border-fg/10 px-6 py-5">
    <span class="eyebrow">Other ways to get paid</span>
    <p class="mt-2 text-sm text-fg/70">
      Shown as instructions on your public invoices. You mark these paid yourself once the money
      lands — Thalermark can't verify cash, checks, Venmo, or Zelle automatically the way it does
      card payments.
    </p>
  </header>
  <form method="POST" action="?/savePaymentMethods" class="grid gap-6 px-6 py-6">
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
        class="w-full max-w-md rounded-sm border border-fg/20 bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
      />
      <textarea
        name="paymentCheckAddress"
        placeholder="Mailing address (optional)"
        rows="2"
        class="w-full max-w-md rounded-sm border border-fg/20 bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
        >{data.company.paymentCheckAddress ?? ''}</textarea
      >
    </div>

    <label class="grid max-w-md gap-1 text-sm text-fg">
      Venmo handle
      <input
        name="paymentVenmoHandle"
        value={data.company.paymentVenmoHandle ?? ''}
        placeholder="@your-handle"
        class="rounded-sm border border-fg/20 bg-surface px-3 py-2 text-fg focus:border-accent focus:outline-none"
      />
    </label>

    <label class="grid max-w-md gap-1 text-sm text-fg">
      Zelle email or phone
      <input
        name="paymentZelleContact"
        value={data.company.paymentZelleContact ?? ''}
        placeholder="you@example.com or 555-0100"
        class="rounded-sm border border-fg/20 bg-surface px-3 py-2 text-fg focus:border-accent focus:outline-none"
      />
    </label>

    <div class="flex items-center gap-4">
      <button
        type="submit"
        class="btn"
      >
        Save payment methods
      </button>
      {#if form?.paymentSaved}
        <span class="text-sm text-success">Saved.</span>
      {/if}
      {#if form?.paymentError}
        <span class="text-sm text-danger">Couldn't save: {form.paymentError}</span>
      {/if}
    </div>
  </form>
</section>
