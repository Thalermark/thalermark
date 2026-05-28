<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  // The three states the page distinguishes:
  //   notStarted  — no stripe_connect_account_id yet, Connect button kicks off Express onboarding
  //   submitted   — details_submitted but not yet charges_enabled, Stripe is reviewing
  //   enabled     — charges_enabled, customers can pay this company
  // stripeNotConfigured is a separate state: the operator hasn't wired
  // STRIPE_* env vars (self-host without payments), nothing to do here.
  const stripeConfigured = $derived(data.status.stripeConfigured);
  const stage = $derived(
    !data.status.stripeConnectAccountId
      ? 'notStarted'
      : data.status.stripeConnectChargesEnabled
        ? 'enabled'
        : 'submitted',
  );
  const buttonLabel = $derived(
    stage === 'notStarted'
      ? 'Connect with Stripe'
      : stage === 'submitted'
        ? 'Continue onboarding'
        : 'Update payout details',
  );
</script>

<h1 class="font-serif text-4xl font-light leading-none tracking-tight text-ink">
  Accept payments<span class="text-gold-deep">.</span>
</h1>

{#if data.stripeReturn === 'return'}
  <div class="mt-6 rounded-sm border border-gold/40 bg-gold/10 px-5 py-4 text-sm text-ink/80">
    Welcome back from Stripe. Your onboarding status below reflects the latest from them — if it
    still says "in review," Stripe is finishing their verification and will email you when you're
    fully enabled.
  </div>
{/if}

{#if !stripeConfigured}
  <div class="mt-8 rounded-sm border border-ink/15 bg-cream-warm px-6 py-5">
    <p class="font-serif text-lg text-ink">Stripe isn't configured.</p>
    <p class="mt-2 text-sm text-ink/70">
      This installation hasn't wired Stripe API keys, so payment collection is unavailable. Set the
      <span class="font-mono text-xs">STRIPE_*</span> environment variables on the server to enable
      it.
    </p>
  </div>
{:else}
  <section class="mt-8 rounded-sm border border-ink/15 bg-cream-warm">
    <header class="border-b border-ink/10 px-6 py-5">
      <span class="eyebrow">Stripe Connect</span>
      <p class="mt-2 font-serif text-lg text-ink">
        {data.company.name}
      </p>
    </header>
    <div class="grid gap-6 px-6 py-6 sm:grid-cols-[1fr_auto] sm:items-center">
      <div>
        {#if stage === 'notStarted'}
          <p class="text-sm text-ink/70">
            Connect a Stripe account so customers can pay your invoices online. Stripe runs the
            onboarding — bank, ID, the lot. Takes a few minutes.
          </p>
        {:else if stage === 'submitted'}
          <p class="text-sm text-ink/70">
            Your details are with Stripe. They're verifying everything and will switch payments on
            automatically when they're done — no further action needed unless they email you.
          </p>
        {:else}
          <p class="text-sm text-ink/70">
            Payments are live. Customers can pay invoices using the pay link on the public invoice
            page.
          </p>
        {/if}
        <dl class="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-xs uppercase tracking-widest text-ink/50">
          <dt>Details submitted</dt>
          <dd class="text-ink/80">{data.status.stripeConnectDetailsSubmitted ? 'yes' : 'no'}</dd>
          <dt>Charges enabled</dt>
          <dd class="text-ink/80">{data.status.stripeConnectChargesEnabled ? 'yes' : 'no'}</dd>
        </dl>
      </div>
      <form method="POST" action="?/onboard">
        <input type="hidden" name="companyId" value={data.company.id} />
        <button
          type="submit"
          class="rounded-sm bg-ink px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
        >
          {buttonLabel}
        </button>
      </form>
    </div>
    {#if form?.onboardError}
      <p class="border-t border-ink/10 px-6 py-3 text-sm text-rose-700">
        Couldn't start onboarding: {form.onboardError}
      </p>
    {/if}
  </section>
{/if}
