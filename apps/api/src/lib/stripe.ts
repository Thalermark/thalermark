import Stripe from 'stripe';

// Thin wrapper around the official Stripe SDK. Construction takes an env
// payload so missing-key handling stays explicit at the caller — the api
// boots without Stripe wired in, the pay-now path on the public invoice
// view stays hidden, and the rest of the app keeps working.
//
// The webhook secret is stored alongside the client because every webhook
// handler needs both — sdk.webhooks.constructEventAsync verifies the
// signature using the secret. Treating them as a single bundle keeps the
// pair in lockstep across env reloads.

export interface StripeBundle {
  client: Stripe;
  publishableKey: string;
  webhookSecret: string;
}

export interface StripeEnv {
  secretKey?: string;
  publishableKey?: string;
  webhookSecret?: string;
}

// Returns null when any required value is missing — caller treats that as
// "Stripe disabled" rather than erroring at boot, so a dev / self-host
// without Stripe configured still runs.
export function createStripeBundle(env: StripeEnv): StripeBundle | null {
  const secret = env.secretKey?.trim();
  const pub = env.publishableKey?.trim();
  const hookSecret = env.webhookSecret?.trim();
  if (!secret || !pub || !hookSecret) return null;
  return {
    client: new Stripe(secret),
    publishableKey: pub,
    webhookSecret: hookSecret,
  };
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
