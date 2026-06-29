import type { Database } from '@thalermark/db';
import { getLogger } from '@thalermark/logger';
import type { Context, MiddlewareHandler } from 'hono';
import { checkRateLimit } from '../lib/rate-limit.js';

const log = getLogger(['api', 'rate-limit']);

// Per-route-class limits. `bucket` namespaces the key in app_rate_limit so the
// same account/token can't collide across classes; windows are in seconds.
//   ai        — per account: the LLM routes (receipt extract, categorize,
//               cash-flow nudges) cost real model spend per call.
//   email     — per account: invoice/estimate sends, capped to blunt spam.
//   publicPay — per invoice token: the unauthenticated PaymentIntent mint,
//               capped so a leaked token can't spawn unbounded Stripe intents.
// Hardcoded like Better Auth's auth customRules — generous for humans, tight
// enough to bound cost/abuse. Tune here if real traffic needs it.
export const RATE_LIMITS = {
  ai: { bucket: 'ai', windowSeconds: 60, max: 60 },
  email: { bucket: 'email', windowSeconds: 60, max: 30 },
  publicPay: { bucket: 'public-pay', windowSeconds: 60, max: 10 },
} as const;

export type RateLimitConfig = { bucket: string; windowSeconds: number; max: number };

// Hono middleware: throttles a route by a key derived from the request (account
// id for authenticated routes, the public token for unauthenticated ones).
// Gated by the same RATE_LIMIT_ENABLED switch as Better Auth's limiter (off
// outside production). Fails OPEN — the limiter is a cost/abuse guardrail, not
// an auth gate, so a limiter-DB hiccup must never take the route down.
export function rateLimit(
  deps: { db: Database; rateLimitEnabled?: boolean },
  config: RateLimitConfig,
  key: (c: Context) => string | undefined,
): MiddlewareHandler {
  return async (c, next) => {
    if (!deps.rateLimitEnabled) return next();
    const id = key(c);
    if (!id) return next(); // unkeyable (e.g. missing account context) → allow
    try {
      const { allowed, retryAfterSeconds } = await checkRateLimit(deps.db, {
        key: `${config.bucket}:${id}`,
        max: config.max,
        windowSeconds: config.windowSeconds,
      });
      if (!allowed) {
        c.header('Retry-After', String(retryAfterSeconds));
        return c.json({ error: 'rate_limited', retryAfter: retryAfterSeconds }, 429);
      }
    } catch (err) {
      log.warn('rate limit check failed, allowing request: {msg}', {
        msg: err instanceof Error ? err.message : String(err),
      });
    }
    return next();
  };
}
