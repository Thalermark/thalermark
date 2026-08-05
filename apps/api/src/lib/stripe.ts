import Stripe from 'stripe';

// Thin wrapper around the official Stripe SDK. Construction takes an env
// payload so missing-key handling stays explicit at the caller — the api
// boots without Stripe wired in, the pay-now path on the public invoice
// view stays hidden, and the rest of the app keeps working.
//
// The webhook secrets are stored alongside the client because every webhook
// handler needs both — sdk.webhooks.constructEventAsync verifies the
// signature using the secret. Treating them as a single bundle keeps them
// in lockstep across env reloads.

export interface StripeBundle {
  client: Stripe;
  publishableKey: string;
  // Every signing secret this install accepts. Plural because a Stripe webhook
  // endpoint covers ONE delivery scope — `POST /v1/webhook_endpoints` takes a
  // boolean `connect` — and each endpoint carries its own secret. An install
  // that takes platform-account charges AND runs Connect therefore has two
  // endpoints and two secrets; verifying against only one drops the other's
  // events on the floor (TMC-176). Never empty: the bundle is null instead.
  webhookSecrets: string[];
}

export interface StripeEnv {
  secretKey?: string;
  publishableKey?: string;
  // Comma-separated for the multi-endpoint case above. A single secret is the
  // common shape and parses to a one-element list, so nothing changes for it.
  webhookSecret?: string;
}

// Returns null when any required value is missing — caller treats that as
// "Stripe disabled" rather than erroring at boot, so a dev / self-host
// without Stripe configured still runs.
export function createStripeBundle(env: StripeEnv): StripeBundle | null {
  const secret = env.secretKey?.trim();
  const pub = env.publishableKey?.trim();
  // Entries trimmed and empties dropped, so a trailing comma or a stray space
  // around a secret is harmless — same shape as AI_ALLOWED_ENDPOINTS.
  const hookSecrets = (env.webhookSecret ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (!secret || !pub || hookSecrets.length === 0) return null;
  return {
    client: new Stripe(secret),
    publishableKey: pub,
    webhookSecrets: hookSecrets,
  };
}

// Verify a delivery against every configured signing secret and return the first
// that checks out. Trying just one is how a mixed install silently loses events:
// the operator must configure the Connect-scoped endpoint or onboarding never
// completes, which leaves platform-account charges arriving under a secret we
// never test (TMC-176). Throws when none verify — the same outcome the
// single-secret path had, minus the false negatives.
export async function constructWebhookEvent(
  bundle: StripeBundle,
  rawBody: string,
  signature: string,
): Promise<Stripe.Event> {
  let lastError: unknown;
  for (const secret of bundle.webhookSecrets) {
    try {
      return await bundle.client.webhooks.constructEventAsync(rawBody, signature, secret);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('no Stripe webhook signing secret configured');
}

// Processor fee withheld from a succeeded PaymentIntent, in minor units
// (TMC-156). Returns null when the fee can't be determined — the caller posts
// the pre-TMC-156 gross-cash shape rather than failing the webhook, because an
// unposted payment is a worse outcome than a missing fee leg.
//
// The fee is not on the PaymentIntent: it lives on the charge's
// balance_transaction, which needs a second round-trip to expand. For Connect
// *direct* charges the charge and its balance transaction live on the connected
// account, so the retrieve has to carry that account — pass the webhook event's
// `account` field, which Stripe sets on direct-charge deliveries and leaves
// undefined on platform ones. Retrieving without it against a direct charge
// resolves on the platform account and 404s (or, worse, silently reads a
// different object), so this is not an optional refinement.
export async function paymentIntentFeeCents(
  client: Stripe,
  intent: Stripe.PaymentIntent,
  connectedAccountId?: string,
): Promise<number | null> {
  const chargeId =
    typeof intent.latest_charge === 'string' ? intent.latest_charge : intent.latest_charge?.id;
  if (!chargeId) return null;
  const requestOptions = connectedAccountId ? { stripeAccount: connectedAccountId } : undefined;
  const charge = await client.charges.retrieve(
    chargeId,
    { expand: ['balance_transaction'] },
    requestOptions,
  );
  const txn = charge.balance_transaction;
  // A string here means the expand didn't resolve; an absent one means the
  // balance transaction isn't available yet (some async payment methods settle
  // later). Either way we don't know the fee.
  if (!txn || typeof txn === 'string') return null;
  return txn.fee;
}

// Money on the wire is decimal-formatted strings (locked invariant per
// architecture_money_decimal_strings). Stripe expects integer minor units
// (cents for USD). Multiply-by-100-and-round is the wrong reflex — floating
// point will lose a penny on values like "0.10". Split on the decimal
// instead, pad/truncate fractional digits to exactly 2, then integer-build
// the cents value. Handles "10", "10.5", "10.55", "0.05".
export function decimalDollarsToCents(decimal: string): number {
  if (!/^\d+(\.\d+)?$/.test(decimal)) {
    throw new Error(`decimalDollarsToCents: invalid decimal "${decimal}"`);
  }
  const [whole, frac = ''] = decimal.split('.');
  const cents = `${frac}00`.slice(0, 2);
  const wholeNum = Number(whole);
  const centsNum = Number(cents);
  if (!Number.isFinite(wholeNum) || !Number.isFinite(centsNum)) {
    throw new Error(`decimalDollarsToCents: not finite "${decimal}"`);
  }
  return wholeNum * 100 + centsNum;
}
