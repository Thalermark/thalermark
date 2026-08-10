import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DeliveryStatus, ProviderDeliveryEvent } from './delivery.js';

// Resend's delivery reports, translated into ours (TMC-226).
//
// This file is the whole provider coupling. Everything below it — the delivery
// columns, the banner, the dashboard query — is written in Thalermark's five
// states, so swapping providers or adding SMTP means writing another mapper
// beside this one and nothing else. That was the condition for building against
// a single provider's webhook at all.
//
// Every shape here was taken from events captured off a real Resend account on
// 2026-08-10 (apps/api/tests/fixtures/resend-webhook-events.json), not from
// memory. The one exception is `email.failed`, which the account never produced
// on demand and which comes from Resend's published payload instead — marked as
// such in the fixture file.

// --- signature -------------------------------------------------------------

// Resend signs with Svix. The signed content is the id, the timestamp and the
// RAW body joined by dots — raw meaning the exact bytes delivered, which is why
// the route reads text() and never lets Hono parse the JSON first.
const SIGNATURE_VERSION = 'v1';
// How far out of step a delivery may be and still be accepted. Bounds replay:
// a captured request stops being useful after this. Svix's own default.
const TOLERANCE_SECONDS = 5 * 60;

export type SvixHeaders = {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
};

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verifyResendSignature(opts: {
  secret: string;
  headers: SvixHeaders;
  rawBody: string;
  now?: Date;
}): VerifyResult {
  const { id, timestamp, signature } = opts.headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing signature headers' };

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return { ok: false, reason: 'unparseable timestamp' };
  const driftSeconds = Math.abs((opts.now ?? new Date()).getTime() / 1000 - sentAt);
  if (driftSeconds > TOLERANCE_SECONDS) return { ok: false, reason: 'timestamp outside tolerance' };

  // The secret is `whsec_` + base64. The prefix is a label, not part of the key.
  const key = Buffer.from(opts.secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${opts.rawBody}`)
    .digest('base64');

  // The header carries a space-separated list so a secret can be rotated with
  // both live at once — any one matching is a pass.
  const offered = signature
    .split(' ')
    .filter((part) => part.startsWith(`${SIGNATURE_VERSION},`))
    .map((part) => part.slice(SIGNATURE_VERSION.length + 1));
  if (offered.length === 0) return { ok: false, reason: 'no v1 signature offered' };

  const match = offered.some((candidate) => {
    // timingSafeEqual throws on a length mismatch, which would itself leak the
    // comparison — so length is checked first and a mismatch is just a miss.
    const a = Buffer.from(candidate);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
  return match ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

// --- mapping ---------------------------------------------------------------

type ResendPayload = {
  type?: unknown;
  created_at?: unknown;
  data?: {
    email_id?: unknown;
    created_at?: unknown;
    bounce?: { type?: unknown; subType?: unknown; message?: unknown; diagnosticCode?: unknown };
    failed?: { reason?: unknown };
  };
};

// Why a send failed, in words. The codes are snake_case and must never reach a
// screen: the browser suite fails the build on a machine identifier rendered as
// copy, which is exactly the class of bug that suite was written for.
//
// These are OUR failures, not the customer's — `reached_daily_quota` says the
// Thalermark account hit a limit, and telling the user to check the address
// would send them chasing a problem they do not have and cannot fix. The copy
// keeps that distinction, because it decides who has to do something.
const FAILURE_REASONS: Record<string, string> = {
  reached_daily_quota: 'The sending account hit its daily limit, so this was never sent.',
};

export function describeFailure(reason: string): string {
  const known = FAILURE_REASONS[reason];
  if (known) return known;
  // An unmapped code still has to be safe to render, so the underscores go.
  // "reached daily quota" reads poorly but reads; `reached_daily_quota` on an
  // invoice page is the defect this whole guard exists to prevent.
  const words = reason.replace(/_/g, ' ').trim();
  return words ? `The email provider refused it: ${words}.` : 'The email provider refused it.';
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

// A bounce is only worth alarming about if it is permanent.
//
// `type: "Permanent"` implies a Transient sibling, and a transient bounce is a
// mailbox that was full an hour ago or a greylisting server — the provider
// retries and it usually lands. Flying a red "this bounced" banner for mail
// that then arrives is the one direction of wrong that costs the user real
// work: they re-key a correct address, or phone a customer to apologise for a
// message that was delivered. So transient bounces are ignored here, alongside
// `email.delivery_delayed`, which is the same situation reported earlier.
function bounceStatus(bounce: NonNullable<ResendPayload['data']>['bounce']): DeliveryStatus | null {
  return String(bounce?.type ?? '').toLowerCase() === 'permanent' ? 'bounced' : null;
}

// Translate one payload. Returns null for anything that should not move the
// document's state — an unknown event type, a soft bounce, a delay — which the
// route acknowledges without writing.
export function mapResendEvent(payload: unknown): ProviderDeliveryEvent | null {
  const body = payload as ResendPayload;
  const type = typeof body?.type === 'string' ? body.type : null;
  const messageId = typeof body?.data?.email_id === 'string' ? body.data.email_id : null;
  if (!type || !messageId) return null;

  // `data.created_at` is when the event happened; the envelope's is when it was
  // dispatched to us. The inner one is the ordering fact, so it is preferred.
  const stamp = firstString(body.data?.created_at) ?? firstString(body.created_at);
  const occurredAt = stamp ? new Date(stamp) : null;
  if (!occurredAt || Number.isNaN(occurredAt.getTime())) return null;

  const base = { messageId, occurredAt };

  switch (type) {
    case 'email.sent':
      return { ...base, status: 'sent', detail: null };
    case 'email.delivered':
      return { ...base, status: 'delivered', detail: null };
    case 'email.bounced': {
      const status = bounceStatus(body.data?.bounce);
      if (!status) return null;
      // diagnosticCode over message on purpose. The provider's `message` is a
      // paragraph about sender reputation written for whoever runs the mail
      // account; the diagnostic code is the far end's own words — "550 5.1.1
      // user unknown" — which is the bit that tells the user what to fix.
      const detail =
        firstString(body.data?.bounce?.diagnosticCode) ?? firstString(body.data?.bounce?.message);
      return { ...base, status: 'bounced', detail };
    }
    case 'email.complained':
      // No detail. The status alone carries the whole fact, and the banner
      // already says it in plainer words than anything we could add — a second
      // sentence repeating it would just be noise under a red box.
      return { ...base, status: 'complained', detail: null };
    case 'email.failed': {
      const reason = firstString(body.data?.failed?.reason);
      return { ...base, status: 'failed', detail: reason ? describeFailure(reason) : null };
    }
    // email.delivery_delayed and anything Resend adds later: acknowledged,
    // never applied. An unrecognised event must not become a state change.
    default:
      return null;
  }
}
