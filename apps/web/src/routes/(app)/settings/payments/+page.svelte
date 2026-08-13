<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  // The stage is decided by the API (onboardingStage in lib/stripe-connect.ts) and
  // rendered here. It used to be derived client-side off the account id alone, which
  // is how this page and the mobile one independently arrived at the same bug: an
  // owner who backed out of Stripe's form was told their details were under review.
  // One server-side answer is the fix for two clients disagreeing.
  //   notStarted   — no account yet
  //   started      — account exists, they backed out before submitting
  //   actionNeeded — Stripe is blocked on them
  //   inReview     — Stripe is verifying; genuinely nothing to do
  //   stopped      — Stripe rejected the account
  //   payoutsHeld  — charges work, the money isn't reaching the bank
  //   enabled      — fully live
  // stripeNotConfigured is a separate state: the operator hasn't wired
  // STRIPE_* env vars (self-host without payments), nothing to do here.
  const stripeConfigured = $derived(data.status.stripeConfigured);
  const stage = $derived(data.status.onboardingStage);
  const buttonLabel = $derived(
    stage === 'notStarted'
      ? 'Connect with Stripe'
      : stage === 'started' || stage === 'actionNeeded'
        ? 'Continue onboarding'
        : stage === 'stopped'
          ? 'Open Stripe'
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
        {:else if stage === 'actionNeeded'}
          <p class="text-sm text-fg/70">
            Stripe needs something else from you before card payments can switch on — usually ID,
            a bank account or business details. They'll show you exactly what when you continue.
          </p>
        {:else if stage === 'inReview'}
          <p class="text-sm text-fg/70">
            Your details are with Stripe. They're verifying everything and will switch payments on
            automatically when they're done — no further action needed unless they email you.
          </p>
        {:else if stage === 'stopped'}
          <p class="text-sm text-fg/70">
            Stripe has stopped this account, so card payments can't be switched on. That decision
            is theirs to explain and to reverse — they'll have emailed the details.
          </p>
        {:else if stage === 'payoutsHeld'}
          <p class="text-sm text-fg/70">
            Contacts can pay you, but Stripe is holding the money rather than paying it out —
            usually a missing bank account or an ID check. Worth clearing before the next invoice.
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
          <dt>Payouts enabled</dt>
          <dd class="text-fg/80">{data.status.stripeConnectPayoutsEnabled ? 'yes' : 'no'}</dd>
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
