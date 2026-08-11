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
