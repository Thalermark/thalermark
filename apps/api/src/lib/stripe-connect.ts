// One definition of "can this company take a card payment yet, and if not, is
// that because its Stripe onboarding is unfinished?"
//
// Two very different audiences read this answer and they must never disagree:
// the public invoice page decides whether to offer a Pay button, and the
// owner's own invoice page decides whether to warn them their online payments
// aren't live. Computing it twice is how the recipient ends up with no button
// while the owner is told everything is fine.

export type ConnectInputs = {
  // STRIPE_REQUIRE_CONNECTED_ACCOUNT (TMC-175). On, a company that never
  // onboarded is simply not payable rather than charging on the platform key.
  requireConnectedAccount: boolean;
  // Whether the deployment has Stripe wired at all.
  stripeConfigured: boolean;
  connectAccountId: string | null;
  chargesEnabled: boolean;
};

export type ConnectState = {
  // Stripe would accept a charge for this company right now.
  connectReady: boolean;
  // Onboarding is started-but-unfinished (or required-but-absent). Distinct
  // from "this deployment has no Stripe at all", which is not the company's
  // doing and is never presented as something they can fix.
  connectPending: boolean;
};

// The slice of Stripe's Account we persist (TMC-256). Structural rather than
// Stripe.Account so the webhook, the read-time reconcile and the tests all agree
// on one projection without any of them owning the SDK type.
export type StripeAccountLike = {
  charges_enabled?: boolean | null;
  details_submitted?: boolean | null;
  payouts_enabled?: boolean | null;
  requirements?: {
    currently_due?: string[] | null;
    past_due?: string[] | null;
    disabled_reason?: string | null;
  } | null;
};

export type ConnectAccountFacts = {
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
  payoutsEnabled: boolean;
  requirementsDue: boolean;
  disabledReason: string | null;
};

// Stripe -> our columns, in one place. Two writers keep these fresh (the
// account.updated webhook and the read-time reconcile) and they must not
// disagree about what "Stripe needs something" means.
export function accountFacts(account: StripeAccountLike): ConnectAccountFacts {
  const req = account.requirements ?? null;
  return {
    chargesEnabled: account.charges_enabled === true,
    detailsSubmitted: account.details_submitted === true,
    payoutsEnabled: account.payouts_enabled === true,
    // Either bucket means the ball is in the owner's court. past_due is just
    // currently_due that blew its deadline, and both are answered by the same
    // "go finish it at Stripe" button.
    requirementsDue: (req?.currently_due?.length ?? 0) > 0 || (req?.past_due?.length ?? 0) > 0,
    disabledReason: req?.disabled_reason ?? null,
  };
}

// What the owner should be told, decided once on the server so web and mobile
// cannot drift (they already did — both shipped the same wrong derivation).
//
//   notStarted   — no account yet
//   started      — account exists, they backed out before submitting
//   actionNeeded — Stripe is blocked on them
//   inReview     — Stripe is verifying; genuinely nothing to do
//   stopped      — Stripe rejected the account; not a wait
//   payoutsHeld  — charges work, money isn't reaching the bank
//   enabled      — fully live
//
// Order is the point. `rejected` is checked before everything because it is the
// one state no amount of waiting fixes, but the OTHER disabled_reason values
// (requirements.past_due, pending_verification) deliberately fall through — they
// describe a stage the states below already name, and better.
export type OnboardingStage =
  | 'notStarted'
  | 'started'
  | 'actionNeeded'
  | 'inReview'
  | 'stopped'
  | 'payoutsHeld'
  | 'enabled';

export function onboardingStage(
  input: ConnectAccountFacts & { connectAccountId: string | null },
): OnboardingStage {
  if (!input.connectAccountId) return 'notStarted';
  if (input.disabledReason?.startsWith('rejected')) return 'stopped';
  if (!input.detailsSubmitted) return 'started';
  if (!input.chargesEnabled) return input.requirementsDue ? 'actionNeeded' : 'inReview';
  if (!input.payoutsEnabled) return 'payoutsHeld';
  return 'enabled';
}

export function connectState(input: ConnectInputs): ConnectState {
  const hasConnect = !!input.connectAccountId;
  // Without the requirement, a company with no connected account falls back to
  // the platform key and is payable — 8.5c behaviour. With it, charges_enabled
  // is the bar for everyone.
  const connectReady = input.requireConnectedAccount
    ? input.chargesEnabled
    : !hasConnect || input.chargesEnabled;
  return {
    connectReady,
    // Gated on stripeConfigured: with no Stripe on the deployment at all there
    // is nothing for the owner to finish, so nothing pending to nag about.
    connectPending:
      input.stripeConfigured && (input.requireConnectedAccount || hasConnect) && !connectReady,
  };
}
